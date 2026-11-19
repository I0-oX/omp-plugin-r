import type { Dirent } from "node:fs";
import { readdir, stat } from "node:fs/promises";
import { join, relative } from "node:path";

/** Directories that hold dependencies or caches, not analysis output. Dot-directories are skipped too. */
const SKIP_DIRS: Record<string, true> = { node_modules: true, __pycache__: true, renv: true, packrat: true, venv: true };

export interface FileSnapshot {
	/** Path relative to the root -> "mtime:ctime:size" signature. */
	files: Map<string, string>;
	/** The scan stopped at its entry limit, so files elsewhere are missing. */
	partial: boolean;
}

export interface ChangedFiles {
	/** Paths relative to the root, sorted. */
	paths: string[];
	/** Either scan stopped at its entry limit, so changes elsewhere may be missing. */
	partial: boolean;
}

/**
 * Records every file under `root` with its mtime, ctime and size, found breadth-first so the
 * shallow files most likely to be analysis output are seen before the entry limit.
 */
export async function snapshotFiles(root: string, maxEntries = 5000): Promise<FileSnapshot> {
	const files = new Map<string, string>();
	const dirs = [root];
	let visited = 0;
	let partial = false;
	for (let i = 0; i < dirs.length && !partial; i++) {
		let entries: Dirent[];
		try {
			entries = await readdir(dirs[i]!, { withFileTypes: true });
		} catch {
			continue; // unreadable or removed meanwhile
		}
		const found: string[] = [];
		for (const entry of entries) {
			if (++visited > maxEntries) {
				partial = true;
				break;
			}
			const full = join(dirs[i]!, entry.name);
			if (entry.isFile()) found.push(full);
			else if (entry.isDirectory() && !entry.name.startsWith(".") && !Object.hasOwn(SKIP_DIRS, entry.name)) {
				dirs.push(full);
			}
		}
		const stats = await Promise.all(found.map(file => stat(file).catch(() => undefined)));
		stats.forEach((s, j) => {
			// ctime too: a copy or download can keep an old mtime but always gets a fresh ctime.
			if (s) files.set(relative(root, found[j]!), `${s.mtimeMs}:${s.ctimeMs}:${s.size}`);
		});
	}
	return { files, partial };
}

/** Files under `root` that are new or whose signature differs from `before`. */
export async function findChangedFiles(root: string, before: FileSnapshot, maxEntries = 5000): Promise<ChangedFiles> {
	const after = await snapshotFiles(root, maxEntries);
	const paths: string[] = [];
	for (const [path, signature] of after.files) {
		if (before.files.get(path) !== signature) paths.push(path);
	}
	return { paths: paths.sort(), partial: before.partial || after.partial };
}
