import { mkdirSync, mkdtempSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "bun:test";
import { findR, rEngine } from "../src/r";
import { Session } from "../src/session";

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

	test("timeout discards the session; the next call is fresh and says so", async () => {
		const s = new Session(rEngine);
		try {
			await run(s, "x <- 1");
			await run(s, "Sys.sleep(30)", 700).catch(() => undefined);
			const after = await run(s, "exists('x')");
			expect(after.output).toContain("FALSE");
			expect(after.notices.join(" ")).toContain("lost");
		} finally {
			s.reset();
		}
	});
});
