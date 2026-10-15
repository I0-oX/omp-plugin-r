import { mkdirSync, mkdtempSync, utimesSync, writeFileSync } from "node:fs";
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
	test("reports files modified since the reference, nested ones included, and not older files", async () => {
		const root = tree(["old.csv", "new.csv", "out/fig.pdf", "out/old.txt"]);
		utimesSync(join(root, "old.csv"), HOUR_AGO, HOUR_AGO);
		utimesSync(join(root, "out/old.txt"), HOUR_AGO, HOUR_AGO);
		const { paths, partial } = await findChangedFiles(root, Date.now() - 60_000);
		expect(paths).toEqual(["new.csv", "out/fig.pdf"]);
		expect(partial).toBe(false);
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
