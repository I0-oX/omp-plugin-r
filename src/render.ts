/**
 * TUI rendering for the `r` tool, modelled on omp's `eval` cells: a rounded frame with a header
 * (status icon, title, duration), the highlighted code, and the output in a section below it;
 * collapsed output keeps a tail preview and ctrl+o expands it.
 *
 * omp does not export its frame helpers (`renderCodeCell`, `markFramedBlockComponent`) to
 * extensions, so the frame is drawn here from the pieces it does expose: the `Theme` handed to
 * the renderer, `@oh-my-pi/pi-tui`, and `pi.pi.highlightCode` / `truncateToVisualLines`.
 */
import { padding, replaceTabs, truncateToWidth, visibleWidth, wrapTextWithAnsi } from "@oh-my-pi/pi-tui";
import type { Component } from "@oh-my-pi/pi-tui";

/** Collapsed output keeps this many trailing rows, like eval's default preview. */
const PREVIEW_LINES = 10;

/** What `execute` hands to the renderer through `details`. */
export interface RDetails {
	/** R's output, without the notes below. */
	output?: string;
	/** Dim lines under the cell: lost-session notices, interrupt/error markers, files written. */
	notes?: string[];
	durationMs?: number;
	plots?: number;
	files?: string[];
	status?: number;
	interrupted?: string;
}

interface RenderArgs {
	code?: string;
}

interface RenderOptions {
	expanded?: boolean;
	isPartial?: boolean;
	spinnerFrame?: number;
}

interface RenderResult {
	content: Array<{ type: string; text?: string }>;
	details?: RDetails;
	isError?: boolean;
}

/** The slice of omp's `Theme` used here. */
interface Theme {
	fg(color: string, text: string): string;
	getBgAnsi(color: string): string;
	styledSymbol(key: string, color: string): string;
	boxRound: { horizontal: string; vertical: string; topLeft: string; topRight: string; bottomLeft: string; bottomRight: string; teeRight: string; teeLeft: string };
	sep: { dot: string };
	spinnerFrames: string[];
}

/** The slice of `pi.pi` used here. */
export interface Host {
	highlightCode(code: string, lang?: string): string[];
	truncateToVisualLines(
		text: string,
		maxVisualLines: number,
		width: number,
	): { visualLines: string[]; skippedCount: number };
	askToolRenderer: { renderCall(args: unknown, options: unknown, theme: unknown): object };
}

type State = "pending" | "running" | "success" | "error";

/** Viewport-sized tail window for code previews (omp's `previewWindowRows`). */
function previewWindowRows(): number {
	return Math.max(6, (process.stdout.rows || 30) - 20);
}

function formatDuration(ms: number): string {
	if (ms < 1000) return `${Math.round(ms)}ms`;
	if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`;
	const s = Math.round(ms / 1000);
	return `${Math.floor(s / 60)}m${s % 60}s`;
}

function statusIcon(state: State, theme: Theme, spinnerFrame?: number): string {
	switch (state) {
		case "success":
			return theme.styledSymbol("status.done", "success");
		case "error":
			return theme.styledSymbol("status.error", "error");
		case "pending":
			return theme.styledSymbol("status.pending", "muted");
		case "running":
			if (spinnerFrame !== undefined) return theme.spinnerFrames[spinnerFrame % theme.spinnerFrames.length];
			return theme.styledSymbol("status.running", "accent");
	}
}

interface Section {
	label?: string;
	lines: string[];
}

/** Same layout as omp's `renderOutputBlock`: header bar, sections split by labelled bars, bottom bar. */
function frame(header: string, meta: string | undefined, state: State, sections: Section[], width: number, theme: Theme): string[] {
	const { horizontal: h, vertical: v } = theme.boxRound;
	const cap = h.repeat(3);
	const borderColor = state === "error" ? "error" : state === "running" || state === "pending" ? "accent" : "dim";
	const border = (text: string) => theme.fg(borderColor, text);
	const bgAnsi = theme.getBgAnsi(
		state === "success" ? "toolSuccessBg" : state === "error" ? "toolErrorBg" : "toolPendingBg",
	);
	// Re-apply the background after inner SGR resets so it survives mid-line.
	const paint = (text: string) =>
		`${bgAnsi}${text.replace(/\x1b\[(?:0)?m/g, m => `${m}${bgAnsi}`).replace(/\x1b\[49m/g, m => `${m}${bgAnsi}`)}\x1b[49m`;
	const fit = (line: string) => paint(line + padding(Math.max(0, width - visibleWidth(line))));

	const contentWidth = Math.max(1, width - 2 * visibleWidth(v) - 2);

	const bar = (left: string, right: string, label?: string): string => {
		const leftGlyphs = `${left}${cap}`;
		if (!label) {
			const fill = Math.max(0, width - visibleWidth(leftGlyphs) - visibleWidth(right));
			return `${border(leftGlyphs)}${border(h.repeat(fill))}${border(right)}`;
		}
		const trimmed = truncateToWidth(` ${label} `, Math.max(0, width - visibleWidth(leftGlyphs) - visibleWidth(right)));
		const fill = Math.max(0, width - visibleWidth(leftGlyphs) - visibleWidth(trimmed) - visibleWidth(right));
		return `${border(leftGlyphs)}${trimmed}${border(h.repeat(fill))}${border(right)}`;
	};

	const rows = [bar(theme.boxRound.topLeft, theme.boxRound.topRight, [header, meta].filter(Boolean).join(theme.sep.dot))];
	for (const section of sections) {
		if (section.label) rows.push(bar(theme.boxRound.teeRight, theme.boxRound.teeLeft, section.label));
		for (const line of section.lines.flatMap(l => l.split("\n"))) {
			for (const wrapped of wrapTextWithAnsi(line.trimEnd(), contentWidth)) {
				rows.push(`${border(v)} ${wrapped}${padding(Math.max(0, contentWidth - visibleWidth(wrapped)))} ${border(v)}`);
			}
		}
	}
	rows.push(bar(theme.boxRound.bottomLeft, theme.boxRound.bottomRight));
	return rows.map(fit);
}

/** Carriage returns overwrite within a line (progress bars); keep only the final segment. Trailing CRs (CRLF) do not count. */
function cleanLine(line: string): string {
	const s = line.replace(/\r+$/, "");
	const i = s.lastIndexOf("\r");
	return replaceTabs(i < 0 ? s : s.slice(i + 1));
}

export function createRenderers(host: Host) {
	/**
	 * omp's framed-block marker is a private Symbol; read it off a component omp itself framed.
	 * Needs the live theme, so it is resolved on first use. Without it omp pads the block and
	 * tints its background, but the frame still draws.
	 */
	let marker: symbol | undefined;
	let markerResolved = false;

	function framed(theme: Theme, key: () => string, build: (width: number) => string[]): Component {
		if (!markerResolved) {
			markerResolved = true;
			try {
				const probe = host.askToolRenderer.renderCall(
					{ questions: [{ id: "a", question: "q", options: [{ label: "a" }] }] },
					{ expanded: false },
					theme,
				);
				marker = Object.getOwnPropertySymbols(probe).find(s => s.description === "framedBlockComponent");
			} catch {
				// keep the unmarked look
			}
		}
		let cached: { key: string; width: number; rows: string[] } | undefined;
		const component = {
			render: (width: number): readonly string[] => {
				const k = key();
				if (cached && cached.key === k && cached.width === width) return cached.rows;
				const rows = build(width);
				cached = { key: k, width, rows };
				return rows;
			},
			invalidate: () => {
				cached = undefined;
			},
		};
		if (marker) (component as Record<symbol, unknown>)[marker] = true;
		return component;
	}

	function cell(
		args: RenderArgs | undefined,
		state: State,
		options: RenderOptions,
		theme: Theme,
		width: number,
		result?: { output: string; durationMs?: number },
	): string[] {
		const expanded = options.expanded === true;

		// Code: tail window while collapsed, so the newest line stays visible as it streams.
		const codeLines = (args?.code ?? "").split(/\r?\n/).map(cleanLine);
		const maxCode = expanded ? codeLines.length : Math.min(codeLines.length, previewWindowRows());
		const hiddenCode = codeLines.length - maxCode;
		const code = host.highlightCode(codeLines.slice(hiddenCode).join("\n"), "r");
		if (hiddenCode > 0) {
			code.unshift(theme.fg("dim", `… ${hiddenCode} earlier line${hiddenCode === 1 ? "" : "s"} (ctrl+o to expand)`));
		}
		const sections: Section[] = [{ lines: code }];

		if (result?.output) {
			const color = state === "error" ? "error" : "toolOutput";
			const styled = result.output
				.split("\n")
				.map(line => theme.fg(color, cleanLine(line)))
				.join("\n");
			let lines: string[];
			let hidden = 0;
			if (expanded) {
				lines = styled.split("\n");
			} else {
				// Bound by visual rows at the box's inner width so a long line cannot wrap past the budget.
				const preview = host.truncateToVisualLines(styled, Math.min(PREVIEW_LINES, previewWindowRows()), Math.max(1, width - 4));
				lines = [...preview.visualLines];
				hidden = preview.skippedCount;
			}
			if (hidden > 0) lines.push(theme.fg("dim", `… ${hidden} more lines (ctrl+o to expand)`));
			sections.push({ label: theme.fg("toolTitle", "Output"), lines });
		}

		const icon = statusIcon(state, theme, options.spinnerFrame);
		const header =
			state === "pending" || state === "running"
				? `${icon} ${theme.fg("muted", state)} ${theme.fg("toolTitle", "R")}`
				: `${icon} ${theme.fg("toolTitle", "R")}`;
		const meta = result?.durationMs !== undefined ? theme.fg("dim", `(${formatDuration(result.durationMs)})`) : undefined;
		return frame(header, meta, state, sections, width, theme);
	}

	function renderCall(args: RenderArgs, options: RenderOptions, theme: Theme): Component {
		const code = args?.code ?? "";
		return framed(
			theme,
			() => `${options.expanded ? 1 : 0}|${options.spinnerFrame ?? "-"}|${previewWindowRows()}|${code.length}`,
			width => cell(args, options.spinnerFrame !== undefined ? "running" : "pending", options, theme, width),
		);
	}

	function renderResult(result: RenderResult, options: RenderOptions, theme: Theme, args?: RenderArgs): Component {
		const details = result.details;
		// The text content is the LLM-facing rendition; prefer the structured output when present.
		const output = (details?.output ?? (result.content.find(c => c.type === "text")?.text ?? "")).replace(/\s+$/, "");
		const notes = details?.notes ?? [];
		const state: State = options.isPartial ? "running" : result.isError ? "error" : "success";

		return framed(
			theme,
			() => `${options.expanded ? 1 : 0}|${options.spinnerFrame ?? "-"}|${previewWindowRows()}|${state}`,
			width => {
				const rows = cell(args, state, options, theme, width, {
					output,
					durationMs: options.isPartial ? undefined : details?.durationMs,
				});
				for (const note of notes) rows.push(truncateToWidth(theme.fg("dim", note), width));
				return rows;
			},
		);
	}

	return { renderCall, renderResult };
}
