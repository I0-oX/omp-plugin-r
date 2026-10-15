import { describe, expect, test } from "bun:test";
import { type Engine, Session, SessionLost } from "../src/session";

/**
 * A fake interpreter: `sh` evaluating each stdin line. `stdinFor` emits the cell
 * (read from the script file) followed by the end marker, like the real engines.
 */
function shEngine(opts: { echoMarker?: boolean } = {}): Engine {
	return {
		name: "sh",
		scriptExt: ".sh",
		bootstrap: "",
		command: () => ({ cmd: "sh", args: ["-c", 'while IFS= read -r line; do eval "$line"; done'] }),
		async stdinFor(run) {
			const marker = `<<OMP-END ${run.token} 0>>`;
			// `. file` runs the cell in the long-lived shell so variables persist.
			const echo = opts.echoMarker ? `printf '%s\\n' 'echoed: <<OMP-END ${run.token} _rc >>'; ` : "";
			return `${echo}. '${run.script}'; printf '\\n${marker}\\n'\n`;
		},
	};
}

const run = (s: Session, code: string, extra: { timeoutMs?: number; signal?: AbortSignal } = {}) =>
	s.run(code, { cwd: process.cwd(), ...extra });

describe.skipIf(process.platform === "win32")("Session protocol", () => {
	test("state persists and trailing marker newline is stripped", async () => {
		const s = new Session(shEngine());
		try {
			await run(s, "x=41");
			const r = await run(s, 'echo "x+1=$((x+1))"');
			expect(r.status).toBe(0);
			expect(r.output).toBe("x+1=42\n");
		} finally {
			s.reset();
		}
	});

	test("output without a trailing newline is preserved", async () => {
		const s = new Session(shEngine());
		try {
			expect((await run(s, "printf abc")).output).toBe("abc");
		} finally {
			s.reset();
		}
	});

	test("a marker-like line in user output or an echoed command is not the end marker", async () => {
		const s = new Session(shEngine({ echoMarker: true }));
		try {
			const r = await run(s, "echo '<<OMP-END deadbeefdeadbeef 0>>'");
			expect(r.status).toBe(0);
			expect(r.output).toContain("echoed: <<OMP-END");
			expect(r.output).toContain("<<OMP-END deadbeefdeadbeef 0>>");
		} finally {
			s.reset();
		}
	});

	test("timeout kills the process, rejects with partial output, and the next run restarts with a notice", async () => {
		const s = new Session(shEngine());
		try {
			await run(s, "keep=1");
			const err = await run(s, "echo partial; sleep 30", { timeoutMs: 400 }).catch(e => e);
			expect(err).toBeInstanceOf(SessionLost);
			expect(err.output).toContain("partial");
			expect(err.message).toContain("timed out");

			const after = await run(s, 'echo "keep=${keep:-unset}"');
			expect(after.output).toBe("keep=unset\n");
			expect(after.notices.join(" ")).toContain("lost");
		} finally {
			s.reset();
		}
	});

	test("abort signal cancels a running cell", async () => {
		const s = new Session(shEngine());
		try {
			const ac = new AbortController();
			// Abort once the cell has demonstrably started, instead of guessing a delay.
			const started = (text: string) => text.includes("started") && ac.abort();
			const err = await s
				.run("echo started; sleep 30", { cwd: process.cwd(), signal: ac.signal, onOutput: started })
				.catch(e => e);
			expect(err).toBeInstanceOf(SessionLost);
			expect(err.message).toContain("cancelled");
		} finally {
			s.reset();
		}
	});

	test("a process that exits mid-cell is reported as lost, not hung", async () => {
		const s = new Session(shEngine());
		try {
			const err = await run(s, "echo bye; exit 3", { timeoutMs: 5000 }).catch(e => e);
			expect(err).toBeInstanceOf(SessionLost);
			expect(err.output).toContain("bye");
		} finally {
			s.reset();
		}
	});

	test("concurrent runs are serialised in call order", async () => {
		const s = new Session(shEngine());
		try {
			const [a, b] = await Promise.all([run(s, "sleep 0.2; echo first"), run(s, "echo second")]);
			expect(a.output).toBe("first\n");
			expect(b.output).toBe("second\n");
		} finally {
			s.reset();
		}
	});

	test("runaway output is bounded, keeping head and tail", async () => {
		const s = new Session(shEngine());
		try {
			const r = await run(s, "i=0; while [ $i -lt 20000 ]; do echo line-$i-xxxxxxxxxxxxxxxxxxxxxxxx; i=$((i+1)); done", {
				timeoutMs: 30_000,
			});
			expect(r.output.length).toBeLessThan(60_000);
			expect(r.output).toContain("line-0-");
			expect(r.output).toContain("line-19999-");
			expect(r.output).toContain("characters elided");
		} finally {
			s.reset();
		}
	});
});
