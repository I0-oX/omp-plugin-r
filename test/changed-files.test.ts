import { mkdirSync, mkdtempSync, statSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "bun:test";
import { findChangedFiles } from "../src/changed-files";

function tree(files: string[]): string {
	const root = mkdtempSync(join(tmpdir(), "omp-changed-"));
	for (const file of files) {
		mkdirSync(join(root, file, ".."), { recursive: true });
		writeFileSync(join(root, file), "x");
	}
	return root;
}

const HOUR_AGO = Date.now() / 1000 - 3600;

describe("findChangedFiles", () => {
	test("reports files changed after the reference, nested ones included, and not older files", async () => {
		const root = tree(["old.csv", "out/old.txt"]);
		utimesSync(join(root, "old.csv"), HOUR_AGO, HOUR_AGO);
		// Real delay on purpose: file timestamps come from a coarse kernel clock, so the
		// reference must fall in a later tick than the setup writes (whose ctime is "now").
		await Bun.sleep(20);
		// Reference from the filesystem clock, taken after the old files were last touched.
		const ref = join(mkdtempSync(join(tmpdir(), "omp-ref-")), "ref");
		writeFileSync(ref, "");
		const since = statSync(ref).mtimeMs;
		writeFileSync(join(root, "new.csv"), "x");
		mkdirSync(join(root, "out"), { recursive: true });
		writeFileSync(join(root, "out/fig.pdf"), "x");
		const { paths, partial } = await findChangedFiles(root, since);
		expect(paths).toEqual(["new.csv", "out/fig.pdf"]);
		expect(partial).toBe(false);
	});

	test("a file created with an old mtime (copy, download) is still reported", async () => {
		const root = tree([]);
		const since = Date.now() - 60_000;
		writeFileSync(join(root, "copied.csv"), "x");
		utimesSync(join(root, "copied.csv"), HOUR_AGO, HOUR_AGO);
		expect((await findChangedFiles(root, since)).paths).toEqual(["copied.csv"]);
	});

	test("skips dependency and dot directories", async () => {
		const root = tree(["a.csv", "node_modules/p/index.js", ".git/HEAD", "renv/library/x/DESCRIPTION", ".RData"]);
		const { paths } = await findChangedFiles(root, Date.now() - 60_000);
		expect(paths).toEqual([".RData", "a.csv"]);
	});

	test("stops at the entry limit and says the scan is partial", async () => {
		const root = tree(["a", "b", "c", "d"]);
		const { paths, partial } = await findChangedFiles(root, Date.now() - 60_000, 2);
		expect(paths).toHaveLength(2);
		expect(partial).toBe(true);
	});
});
