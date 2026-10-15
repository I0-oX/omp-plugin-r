import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "bun:test";
import { findR, rEngine } from "../src/r";
import { findChangedFiles } from "../src/changed-files";
import { Session, SessionLost } from "../src/session";

const hasR = findR() !== undefined;
const run = (s: Session, code: string, timeoutMs = 60_000) => s.run(code, { cwd: process.cwd(), timeoutMs });

describe.skipIf(!hasR)("R engine", () => {
	test("state persists; values auto-print; errors do not kill the session", async () => {
		const s = new Session(rEngine);
		try {
			await run(s, "fit <- lm(mpg ~ wt, mtcars)");
			const coef = await run(s, "round(coef(fit), 3)");
			expect(coef.status).toBe(0);
			expect(coef.output).toContain("37.285");

			const bad = await run(s, 'stop("boom")');
			expect(bad.status).toBe(1);
			expect(bad.output).toContain("Error: boom");

			expect((await run(s, "exists('fit')")).output).toContain("TRUE");
		} finally {
			s.reset();
		}
	});

	test("a syntax error is a failed cell, not a lost session", async () => {
		const s = new Session(rEngine);
		try {
			await run(s, "kept <- 1");
			const bad = await run(s, "1 +* 2");
			expect(bad.status).toBe(1);
			expect((await run(s, "kept")).output).toContain("[1] 1");
		} finally {
			s.reset();
		}
	});

	test("warnings are reported and execution continues", async () => {
		const s = new Session(rEngine);
		try {
			const r = await run(s, 'as.integer("a"); cat("after\\n")');
			expect(r.status).toBe(0);
			expect(r.output).toContain("Warning");
			expect(r.output).toContain("after");
		} finally {
			s.reset();
		}
	});

	test("plots come back as PNGs, and dev.off() does not make a later plot overwrite an earlier one", async () => {
		const s = new Session(rEngine);
		try {
			const r = await run(s, "plot(1:4, main = 'Q1'); dev.off(); plot(1:5, main = 'Q2')");
			expect(r.status).toBe(0);
			expect(r.plots).toHaveLength(2);
			for (const png of r.plots) expect(png.subarray(1, 4).toString()).toBe("PNG");
			expect(r.plots[0]!.equals(r.plots[1]!)).toBe(false);

			// Counter is session-wide: a later cell's plot never reuses an earlier name.
			const next = await run(s, "plot(1:3)");
			expect(next.plots).toHaveLength(1);
		} finally {
			s.reset();
		}
	});

	test("runs in the requested working directory, including paths with spaces and quotes", async () => {
		const base = realpathSync(mkdtempSync(join(tmpdir(), "omp-r-cwd-")));
		const odd = join(base, `my "dir" $HOME`);
		mkdirSync(odd);
		const s = new Session(rEngine);
		try {
			const r = await s.run("cat(basename(getwd()))", { cwd: odd, timeoutMs: 60_000 });
			expect(r.output).toBe(`my "dir" $HOME`);
		} finally {
			s.reset();
		}
	});

	test("non-ASCII text survives in a C locale", async () => {
		const prev = process.env.LC_ALL;
		process.env.LC_ALL = "C";
		const s = new Session(rEngine);
		try {
			const r = await run(s, 'cat("naïve 日本")');
			expect(r.output).toBe("naïve 日本");
		} finally {
			s.reset();
			if (prev === undefined) delete process.env.LC_ALL;
			else process.env.LC_ALL = prev;
		}
	});

	test("a timeout interrupts the cell and keeps the session's objects", async () => {
		const s = new Session(rEngine);
		try {
			await run(s, "x <- 1");
			const r = await run(s, 'cat("before\\n"); Sys.sleep(30); cat("not reached\\n")', 700);
			expect(r.interrupted).toContain("timed out");
			expect(r.output).toContain("before");
			expect(r.output).not.toContain("not reached");
			const after = await run(s, "exists('x')");
			expect(after.output).toContain("TRUE");
			expect(after.notices).toEqual([]);
		} finally {
			s.reset();
		}
	});

	test("code that ignores the interrupt is killed after the grace period and the loss is reported", async () => {
		const s = new Session(rEngine, { interruptGraceMs: 300 });
		try {
			await run(s, "x <- 1");
			// tryCatch swallowing the interrupt inside a loop: the cell never stops on its own.
			const err = await run(s, "repeat tryCatch(Sys.sleep(30), interrupt = function(i) NULL)", 500).catch(e => e);
			expect(err).toBeInstanceOf(SessionLost);
			expect(err.message).toContain("did not stop");
			const after = await run(s, "exists('x')");
			expect(after.output).toContain("FALSE");
			expect(after.notices.join(" ")).toContain("lost");
		} finally {
			s.reset();
		}
	});

	test("startedAt identifies files the cell wrote", async () => {
		const dir = realpathSync(mkdtempSync(join(tmpdir(), "omp-r-files-")));
		writeFileSync(join(dir, "old.csv"), "a\n");
		const s = new Session(rEngine);
		try {
			const r = await s.run('write.csv(mtcars, "new.csv")', { cwd: dir, timeoutMs: 60_000 });
			expect((await findChangedFiles(dir, r.startedAt)).paths).toEqual(["new.csv"]);
		} finally {
			s.reset();
		}
	});

	test("clearing the workspace with rm(list = ls(all.names = TRUE)) does not break the session", async () => {
		const s = new Session(rEngine);
		try {
			await run(s, "a <- 1");
			await run(s, "rm(list = ls(all.names = TRUE))");
			const r = await run(s, "exists('a'); 1 + 1");
			expect(r.status).toBe(0);
			expect(r.output).toContain("[1] 2");
		} finally {
			s.reset();
		}
	});

	test("an interrupt arriving right as a cell starts still keeps the session", async () => {
		const s = new Session(rEngine, { interruptGraceMs: 1000 });
		try {
			await run(s, "x <- 1");
			// The 2nd cell of a fresh R is slow to start (JIT), so a 5 ms timeout lands before the cell body.
			for (let i = 0; i < 5; i++) {
				const r = await run(s, "Sys.sleep(30)", 5);
				expect(r.interrupted).toContain("timed out");
			}
			expect((await run(s, "x")).output).toContain("[1] 1");
		} finally {
			s.reset();
		}
	});

	test("detach() in user code does not break the session", async () => {
		const s = new Session(rEngine);
		try {
			await run(s, "keep <- 1");
			await run(s, "detach(); detach()");
			const r = await run(s, "keep + 1");
			expect(r.output).toContain("[1] 2");
		} finally {
			s.reset();
		}
	});

	test("a message sink left open by user code is reset, so later messages are seen", async () => {
		const s = new Session(rEngine);
		try {
			await run(s, 'zz <- file(tempfile(), open = "wt"); sink(zz, type = "message")');
			expect((await run(s, 'message("hello")')).output).toContain("hello");
		} finally {
			s.reset();
		}
	});

	test("a sink() left open by user code is closed so the end marker is still seen", async () => {
		const s = new Session(rEngine);
		try {
			const hidden = await run(s, `sink(tempfile()); cat("into the sink")`);
			expect(hidden.status).toBe(0);
			expect(hidden.output).not.toContain("into the sink");
			expect((await run(s, 'cat("visible")')).output).toBe("visible");
		} finally {
			s.reset();
		}
	});

	test("a working directory containing a newline works", async () => {
		const base = realpathSync(mkdtempSync(join(tmpdir(), "omp-r-nl-")));
		const odd = join(base, "a\nb");
		mkdirSync(odd);
		const s = new Session(rEngine);
		try {
			const r = await s.run("cat(basename(getwd()))", { cwd: odd, timeoutMs: 60_000 });
			expect(r.status).toBe(0);
			expect(r.output).toBe("a\nb");
		} finally {
			s.reset();
		}
	});

	test("a cwd that cannot be entered fails the cell instead of running in the previous directory", async () => {
		const base = realpathSync(mkdtempSync(join(tmpdir(), "omp-r-gone-")));
		const here = join(base, "here");
		const gone = join(base, "gone");
		mkdirSync(here);
		mkdirSync(gone);
		const s = new Session(rEngine);
		try {
			await s.run("1", { cwd: here, timeoutMs: 60_000 });
			rmSync(gone, { recursive: true });
			const r = await s.run('cat("ran")', { cwd: gone, timeoutMs: 60_000 });
			expect(r.status).toBe(1);
			expect(r.output).toContain("cannot change working directory");
			expect(r.output).not.toContain("ran");
		} finally {
			s.reset();
		}
	});

	test("findR rejects an R_BIN that is not executable", () => {
		const prev = process.env.R_BIN;
		process.env.R_BIN = "/nonexistent/R";
		try {
			expect(findR()).toBeUndefined();
		} finally {
			if (prev === undefined) delete process.env.R_BIN;
			else process.env.R_BIN = prev;
		}
	});
});
