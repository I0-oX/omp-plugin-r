import { type ChildProcess, spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { StringDecoder } from "node:string_decoder";

/** Everything an engine needs to run one cell. All paths are absolute. */
export interface Run {
	/** Per-run scratch directory (removed afterwards). */
	dir: string;
	/** File holding the user's code. */
	script: string;
	/** Directory the cell must run in. */
	cwd: string;
	/** Unique per-run token; the end marker is `<<OMP-END <token> <status>>>`. */
	token: string;
	/** Directory where the engine should drop PNG plots (sorted by name). */
	plotDir: string;
}

/** A persistent interpreter that can be driven through stdin. */
export interface Engine {
	/** Display name, e.g. "R". */
	name: string;
	/** Extension for the cell script. */
	scriptExt: string;
	/** Resolve the interpreter command. Throws `EngineUnavailable` when missing. */
	command(): { cmd: string; args: string[] };
	/** Sent to stdin once after the process starts. */
	bootstrap: string;
	/** Text written to stdin to run `run.script` and then print the end marker. */
	stdinFor(run: Run): Promise<string>;
}

export class EngineUnavailable extends Error {}

export interface RunResult {
	/** Combined stdout+stderr of the cell, bounded. */
	output: string;
	/** Engine status for the cell (0 = success). */
	status: number;
	/** PNG plots produced by the cell. */
	plots: Buffer[];
	/** Out-of-band remarks (e.g. the session was restarted). */
	notices: string[];
}

export interface RunOptions {
	cwd: string;
	signal?: AbortSignal;
	/** Milliseconds; 0/undefined = no deadline. */
	timeoutMs?: number;
	/** Called with the output so far while the cell runs. */
	onOutput?: (text: string) => void;
}

/** Thrown when the engine process died, was cancelled, or timed out; the output so far is attached. */
export class SessionLost extends Error {
	constructor(
		message: string,
		readonly output: string,
	) {
		super(message);
	}
}

const HEAD_MAX = 16_000;
const TAIL_MAX = 32_000;

/** Keeps the first HEAD_MAX chars and the last TAIL_MAX chars of an unbounded stream. */
class BoundedOutput {
	#head = "";
	#tail = "";
	#dropped = 0;

	push(chunk: string): void {
		this.#tail += chunk;
		if (this.#tail.length <= TAIL_MAX + 4096) return;
		const moved = this.#tail.slice(0, this.#tail.length - TAIL_MAX);
		this.#tail = this.#tail.slice(moved.length);
		const room = HEAD_MAX - this.#head.length;
		if (room > 0) this.#head += moved.slice(0, room);
		this.#dropped += Math.max(0, moved.length - Math.max(0, room));
	}

	/** Search only the tail: the end marker is always among the most recent bytes. */
	search(re: RegExp): RegExpExecArray | null {
		return re.exec(this.#tail);
	}

	/** Text with the tail cut at `tailEnd` (or whole when omitted). */
	text(tailEnd?: number): string {
		const tail = tailEnd === undefined ? this.#tail : this.#tail.slice(0, tailEnd);
		const gap = this.#dropped > 0 ? `\n[... ${this.#dropped} characters elided ...]\n` : "";
		return this.#head + gap + tail;
	}
}

const live = new Set<Session>();
let exitHookInstalled = false;

function killTree(proc: ChildProcess): void {
	if (proc.pid === undefined) return;
	try {
		if (process.platform === "win32") proc.kill();
		else process.kill(-proc.pid, "SIGKILL");
	} catch {
		proc.kill("SIGKILL");
	}
}

/**
 * One persistent interpreter process. Cells run strictly one at a time; a cell is a
 * file executed by the engine, followed by an end marker carrying a per-run token.
 * Cancelling, timing out, or losing the process discards the session (its state cannot
 * be re-synchronised) and the next run starts a fresh one.
 */
export class Session {
	#proc: ChildProcess | undefined;
	#lost = false;
	#chain: Promise<unknown> = Promise.resolve();
	#onData: ((chunk: string) => void) | undefined;
	#onExit: ((why: string) => void) | undefined;
	#deathReason: string | undefined;

	constructor(readonly engine: Engine) {}

	/** Run a cell; concurrent calls queue. */
	run(code: string, opts: RunOptions): Promise<RunResult> {
		const next = this.#chain.then(() => this.#run(code, opts));
		this.#chain = next.catch(() => undefined);
		return next;
	}

	/** Discard the process and all state, failing any in-flight cell. The next run reports the loss. */
	kill(): void {
		if (!this.#proc) return;
		this.#terminate();
		this.#lost = true;
		this.#deathReason = `${this.engine.name} session was terminated`;
		this.#onExit?.(this.#deathReason);
	}

	/** Like kill(), but the next run is not reported as a lost session. */
	reset(): void {
		this.kill();
		this.#lost = false;
	}

	#terminate(): void {
		const proc = this.#proc;
		this.#proc = undefined;
		live.delete(this);
		if (proc) killTree(proc);
	}

	#start(cwd: string): void {
		const { cmd, args } = this.engine.command();
		const proc = spawn(cmd, args, {
			cwd,
			stdio: ["pipe", "pipe", "pipe"],
			detached: process.platform !== "win32", // own process group: terminal ^C must not hit it
			windowsHide: true,
		});
		this.#proc = proc;
		this.#deathReason = undefined;
		live.add(this);
		if (!exitHookInstalled) {
			exitHookInstalled = true;
			process.on("exit", () => {
				for (const session of live) session.kill();
			});
		}
		// One decoder per stream so multi-byte characters split across chunks stay intact.
		const feed = (decoder: StringDecoder) => (chunk: Buffer) => this.#onData?.(decoder.write(chunk));
		proc.stdout?.on("data", feed(new StringDecoder("utf8")));
		proc.stderr?.on("data", feed(new StringDecoder("utf8")));
		proc.stdin?.on("error", () => undefined); // EPIPE surfaces through "close"
		proc.on("error", err => this.#die(proc, `failed to start ${cmd}: ${err.message}`));
		const gone = (code: number | null, signal: NodeJS.Signals | null) =>
			this.#die(proc, `${this.engine.name} exited unexpectedly (${signal ?? `code ${code}`})`);
		proc.on("close", gone);
		// A grandchild holding our pipes delays "close"; after "exit" give buffered output a moment, then fail.
		proc.on("exit", (code, signal) => setTimeout(() => gone(code, signal), 1000).unref());
		if (this.engine.bootstrap) proc.stdin?.write(this.engine.bootstrap);
	}

	/** The process is gone or unusable; fail any in-flight cell. */
	#die(proc: ChildProcess, why: string): void {
		if (this.#proc !== proc) return;
		this.#terminate();
		this.#lost = true;
		this.#deathReason = why;
		this.#onExit?.(why);
	}

	async #run(code: string, opts: RunOptions): Promise<RunResult> {
		opts.signal?.throwIfAborted();
		const notices: string[] = [];
		if (!this.#proc) {
			this.#start(opts.cwd);
			if (this.#lost) {
				notices.push(`${this.engine.name} session was lost earlier; started a fresh one (previous state is gone).`);
				this.#lost = false;
			}
		}
		const proc = this.#proc;
		if (!proc?.stdin) throw new SessionLost(`${this.engine.name} is not running`, "");

		const dir = await mkdtemp(join(tmpdir(), `omp-${this.engine.name.toLowerCase()}-`));
		try {
			const script = join(dir, `cell${this.engine.scriptExt}`);
			await writeFile(script, code.endsWith("\n") ? code : `${code}\n`, "utf8");
			const plotDir = join(dir, "plots");
			await mkdir(plotDir);
			const token = randomBytes(8).toString("hex");
			const stdin = await this.engine.stdinFor({ dir, script, cwd: opts.cwd, token, plotDir });

			const { output, status } = await this.#await(proc, token, stdin, opts);
			const plots: Buffer[] = [];
			for (const name of (await readdir(plotDir)).sort()) {
				if (name.toLowerCase().endsWith(".png")) plots.push(await readFile(join(plotDir, name)));
			}
			return { output, status, plots, notices };
		} finally {
			await rm(dir, { recursive: true, force: true });
		}
	}

	#await(
		proc: ChildProcess,
		token: string,
		stdin: string,
		opts: RunOptions,
	): Promise<{ output: string; status: number }> {
		if (this.#proc !== proc) {
			// The process died while the cell was being prepared; nothing will ever answer.
			return Promise.reject(new SessionLost(this.#deathReason ?? `${this.engine.name} is not running`, ""));
		}
		const marker = new RegExp(`<<OMP-END ${token}\\s+(-?\\d+)\\s*>>`);
		const out = new BoundedOutput();
		const { promise, resolve, reject } = Promise.withResolvers<{ output: string; status: number }>();
		let timer: ReturnType<typeof setTimeout> | undefined;

		const settle = () => {
			clearTimeout(timer);
			opts.signal?.removeEventListener("abort", onAbort);
			this.#onData = undefined;
			this.#onExit = undefined;
		};
		const lose = (why: string) => {
			settle();
			if (this.#proc === proc) {
				this.#terminate();
				this.#lost = true;
			}
			reject(new SessionLost(why, out.text()));
		};
		const onAbort = () => lose(`${this.engine.name} cell cancelled`);

		this.#onData = chunk => {
			out.push(chunk);
			const m = out.search(marker);
			if (!m) {
				opts.onOutput?.(out.text());
				return;
			}
			settle();
			// The wrapper prints one newline before the marker to terminate a partial line.
			const end = out.text(m.index).endsWith("\n") ? m.index - 1 : m.index;
			resolve({ output: out.text(end), status: Number(m[1]) });
		};
		this.#onExit = why => {
			settle();
			reject(new SessionLost(why, out.text()));
		};
		opts.signal?.addEventListener("abort", onAbort, { once: true });
		if (opts.timeoutMs && opts.timeoutMs > 0) {
			timer = setTimeout(
				() => lose(`${this.engine.name} cell timed out after ${opts.timeoutMs! / 1000}s`),
				opts.timeoutMs,
			);
		}
		if (opts.signal?.aborted) {
			onAbort();
			return promise;
		}
		proc.stdin?.write(stdin);
		return promise;
	}
}
