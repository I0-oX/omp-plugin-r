import { type ChildProcess, spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdir, mkdtemp, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
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
	/**
	 * Text written to stdin to run `run.script` and then print the end marker. It must
	 * survive SIGINT: an interrupted cell still prints the marker and the process lives on.
	 */
	stdinFor(run: Run): Promise<string>;
}

export class EngineUnavailable extends Error {}

export interface SessionOptions {
	/** Stop the interpreter after this long without a running cell; 0/undefined = never. */
	idleMs?: number;
	/** After a timeout or cancel, how long the interrupted cell may take to stop before the process is killed. */
	interruptGraceMs?: number;
}

export interface RunResult {
	/** Combined stdout+stderr of the cell, bounded. */
	output: string;
	/** Engine status for the cell (0 = success). */
	status: number;
	/** PNG plots produced by the cell. */
	plots: Buffer[];
	/** Out-of-band remarks (e.g. the session was restarted). */
	notices: string[];
	/** Filesystem time (ms) just before the cell ran; files with a newer mtime were written by it. */
	startedAt: number;
	/** Why the cell was interrupted (timeout or cancel); the interpreter survived with its state. */
	interrupted?: string;
}

export interface RunOptions {
	cwd: string;
	signal?: AbortSignal;
	/** Milliseconds; 0/undefined = no deadline. */
	timeoutMs?: number;
	/** Called with the output so far while the cell runs. */
	onOutput?: (text: string) => void;
}

/** Thrown when the engine process died or was killed; the output so far is attached. */
export class SessionLost extends Error {
	constructor(
		message: string,
		readonly output: string,
		/** Set when the cell had started; see `RunResult.startedAt`. */
		readonly startedAt?: number,
	) {
		super(message);
	}
}

const HEAD_MAX = 16_000;
const TAIL_MAX = 32_000;
const DEFAULT_INTERRUPT_GRACE_MS = 2000;
/** setTimeout fires after ~1 ms for delays above this, so every timer is clamped to it. */
const MAX_TIMER_MS = 2 ** 31 - 1;

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

/** Signal the interpreter's whole process group, so children it started (e.g. `system()`) get it too. */
function signalTree(proc: ChildProcess, signal: NodeJS.Signals): void {
	if (proc.pid === undefined) return;
	try {
		if (process.platform === "win32") proc.kill(signal);
		else process.kill(-proc.pid, signal);
	} catch {
		proc.kill(signal);
	}
}

/**
 * One persistent interpreter process. Cells run strictly one at a time; a cell is a
 * file executed by the engine, followed by an end marker carrying a per-run token.
 * A timeout or cancel interrupts the cell (SIGINT, like Ctrl-C); if it does not stop
 * within the grace period, or the process dies, the session is discarded and the next
 * run starts a fresh one and reports why.
 */
export class Session {
	#proc: ChildProcess | undefined;
	/** Why the previous process went away; reported once by the next run. */
	#lostReason: string | undefined;
	#chain: Promise<unknown> = Promise.resolve();
	#onData: ((chunk: string) => void) | undefined;
	#onExit: ((why: string) => void) | undefined;
	#idleTimer: NodeJS.Timeout | undefined;

	constructor(
		readonly engine: Engine,
		readonly options: SessionOptions = {},
	) {}

	/** Run a cell; concurrent calls queue. */
	run(code: string, opts: RunOptions): Promise<RunResult> {
		const next = this.#chain.then(() => this.#run(code, opts));
		this.#chain = next.catch(() => undefined);
		return next;
	}

	/** Discard the process and all state, failing any in-flight cell. The next run reports the loss. */
	kill(): void {
		if (!this.#proc) return;
		this.#terminate(`${this.engine.name} session was terminated`);
		this.#onExit?.(this.#lostReason!);
	}

	/** Like kill(), but the next run is not reported as a lost session. */
	reset(): void {
		this.kill();
		this.#lostReason = undefined;
	}

	#terminate(reason: string): void {
		clearTimeout(this.#idleTimer);
		const proc = this.#proc;
		this.#proc = undefined;
		this.#lostReason = reason;
		live.delete(this);
		if (proc) signalTree(proc, "SIGKILL");
	}

	#scheduleIdle(): void {
		const idleMs = this.options.idleMs;
		if (!idleMs || !this.#proc) return;
		const idle = idleMs >= 60_000 ? `${idleMs / 60_000} min` : `${idleMs / 1000} s`;
		this.#idleTimer = setTimeout(
			() => this.#terminate(`${this.engine.name} was stopped after ${idle} without calls`),
			Math.min(idleMs, MAX_TIMER_MS),
		);
		this.#idleTimer.unref();
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
		this.#terminate(why);
		this.#onExit?.(why);
	}

	async #run(code: string, opts: RunOptions): Promise<RunResult> {
		clearTimeout(this.#idleTimer);
		opts.signal?.throwIfAborted();
		const notices: string[] = [];
		if (!this.#proc) {
			this.#start(opts.cwd);
			if (this.#lostReason) {
				notices.push(
					`${this.engine.name} session was lost (${this.#lostReason}); started a fresh one, so previous objects are gone.`,
				);
				this.#lostReason = undefined;
			}
		}
		const proc = this.#proc;
		if (!proc?.stdin) throw new SessionLost(`${this.engine.name} is not running`, "");

		const dir = await mkdtemp(join(tmpdir(), `omp-${this.engine.name.toLowerCase()}-`));
		try {
			const script = join(dir, `cell${this.engine.scriptExt}`);
			await writeFile(script, code.endsWith("\n") ? code : `${code}\n`, "utf8");
			// The script's mtime comes from the same kernel clock as the mtimes of files the cell writes.
			const startedAt = (await stat(script)).mtimeMs;
			const plotDir = join(dir, "plots");
			await mkdir(plotDir);
			const token = randomBytes(8).toString("hex");
			const stdin = await this.engine.stdinFor({ dir, script, cwd: opts.cwd, token, plotDir });

			const { output, status, interrupted } = await this.#await(proc, token, stdin, startedAt, opts);
			const plots: Buffer[] = [];
			for (const name of (await readdir(plotDir)).sort()) {
				if (name.toLowerCase().endsWith(".png")) plots.push(await readFile(join(plotDir, name)));
			}
			return { output, status, plots, notices, startedAt, interrupted };
		} finally {
			await rm(dir, { recursive: true, force: true });
			this.#scheduleIdle();
		}
	}

	#await(
		proc: ChildProcess,
		token: string,
		stdin: string,
		startedAt: number,
		opts: RunOptions,
	): Promise<{ output: string; status: number; interrupted?: string }> {
		// Aborted while the cell was being prepared: it never ran, so the session is untouched.
		opts.signal?.throwIfAborted();
		if (this.#proc !== proc) {
			// The process died while the cell was being prepared; nothing will ever answer.
			return Promise.reject(new SessionLost(this.#lostReason ?? `${this.engine.name} is not running`, "", startedAt));
		}
		const marker = new RegExp(`<<OMP-END ${token}\\s+(-?\\d+)\\s*>>`);
		const out = new BoundedOutput();
		const { promise, resolve, reject } = Promise.withResolvers<{
			output: string;
			status: number;
			interrupted?: string;
		}>();
		let timer: NodeJS.Timeout | undefined;
		let interrupted: string | undefined;
		const grace = this.options.interruptGraceMs ?? DEFAULT_INTERRUPT_GRACE_MS;

		const settle = () => {
			clearTimeout(timer);
			opts.signal?.removeEventListener("abort", onAbort);
			this.#onData = undefined;
			this.#onExit = undefined;
		};
		// Timeout or cancel: interrupt like Ctrl-C so the interpreter keeps its state; kill it if it does not stop.
		const interrupt = (why: string) => {
			if (interrupted) return;
			interrupted = why;
			clearTimeout(timer);
			signalTree(proc, "SIGINT");
			timer = setTimeout(() => {
				settle();
				const lost = `${why}; ${this.engine.name} did not stop within ${grace / 1000}s of an interrupt and was killed`;
				if (this.#proc === proc) this.#terminate(lost);
				reject(new SessionLost(lost, out.text(), startedAt));
			}, grace);
		};
		const onAbort = () => interrupt(`${this.engine.name} cell cancelled`);

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
			resolve({ output: out.text(end), status: Number(m[1]), interrupted });
		};
		this.#onExit = why => {
			settle();
			reject(new SessionLost(interrupted ? `${interrupted}; ${why}` : why, out.text(), startedAt));
		};
		opts.signal?.addEventListener("abort", onAbort, { once: true });
		if (opts.timeoutMs && opts.timeoutMs > 0) {
			timer = setTimeout(
				() => interrupt(`${this.engine.name} cell timed out after ${opts.timeoutMs! / 1000}s`),
				Math.min(opts.timeoutMs, MAX_TIMER_MS),
			);
		}
		proc.stdin?.write(stdin);
		return promise;
	}
}
