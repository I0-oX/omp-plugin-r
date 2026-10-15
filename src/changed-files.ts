import type { Dirent } from "node:fs";
import { readdir, stat } from "node:fs/promises";
import { join, relative } from "node:path";

/** Directories that hold dependencies or caches, not analysis output. Dot-directories are skipped too. */
const SKIP_DIRS: Record<string, true> = { node_modules: true, __pycache__: true, renv: true, packrat: true, venv: true };

export interface ChangedFiles {
	/** Paths relative to the root, sorted. */
	paths: string[];
	/** The scan stopped at its entry limit, so changes elsewhere may be missing. */
	partial: boolean;
}

/**
 * Files under `root` whose mtime is at or after `sinceMs`, found breadth-first so the
 * shallow files most likely to be analysis output are seen before the entry limit.
 */
export async function findChangedFiles(root: string, sinceMs: number, maxEntries = 5000): Promise<ChangedFiles> {
	const paths: string[] = [];
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
		const files: string[] = [];
		for (const entry of entries) {
			if (++visited > maxEntries) {
				partial = true;
				break;
			}
			const full = join(dirs[i]!, entry.name);
			if (entry.isFile()) files.push(full);
			else if (entry.isDirectory() && !entry.name.startsWith(".") && !Object.hasOwn(SKIP_DIRS, entry.name)) {
				dirs.push(full);
			}
		}
		const stats = await Promise.all(files.map(file => stat(file).catch(() => undefined)));
		stats.forEach((s, j) => {
			if (s && s.mtimeMs >= sinceMs) paths.push(relative(root, files[j]!));
		});
	}
	return { paths: paths.sort(), partial };
}
