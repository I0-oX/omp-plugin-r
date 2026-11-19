import { mkdirSync, mkdtempSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "bun:test";
import { findChangedFiles, snapshotFiles } from "../src/changed-files";

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
	test("files already present, even with just-written timestamps, are not reported", async () => {
		// The reported bug: a cwd whose files look newer than any reference clock (fresh ctime/mtime)
		// was listed in full. Only a before/after comparison is immune to that.
		const root = tree(["Demostraciones/drive.zip", "Demostraciones/img/a.jpg", "data.csv"]);
		const before = await snapshotFiles(root);
		const { paths, partial } = await findChangedFiles(root, before);
		expect(paths).toEqual([]);
		expect(partial).toBe(false);
	});

	test("reports new and modified files, nested ones included, and not untouched ones", async () => {
		const root = tree(["old.csv", "out/old.txt", "edit.csv"]);
		const before = await snapshotFiles(root);
		writeFileSync(join(root, "new.csv"), "x");
		writeFileSync(join(root, "out/fig.pdf"), "x");
		writeFileSync(join(root, "edit.csv"), "longer content");
		const { paths } = await findChangedFiles(root, before);
		expect(paths).toEqual(["edit.csv", "new.csv", "out/fig.pdf"]);
	});

	test("a file created with an old mtime (copy, download) is still reported", async () => {
		const root = tree([]);
		const before = await snapshotFiles(root);
		writeFileSync(join(root, "copied.csv"), "x");
		utimesSync(join(root, "copied.csv"), HOUR_AGO, HOUR_AGO);
		expect((await findChangedFiles(root, before)).paths).toEqual(["copied.csv"]);
	});

	test("skips dependency and dot directories", async () => {
		const root = tree([]);
		const before = await snapshotFiles(root);
		for (const file of ["a.csv", "node_modules/p/index.js", ".git/HEAD", "renv/library/x/DESCRIPTION", ".RData"]) {
			mkdirSync(join(root, file, ".."), { recursive: true });
			writeFileSync(join(root, file), "x");
		}
		const { paths } = await findChangedFiles(root, before);
		expect(paths).toEqual([".RData", "a.csv"]);
	});

	test("stops at the entry limit and says the scan is partial", async () => {
		const root = tree(["a", "b", "c", "d"]);
		const before = await snapshotFiles(root, 2);
		expect(before.partial).toBe(true);
		const { partial } = await findChangedFiles(root, before, 2);
		expect(partial).toBe(true);
	});
});
