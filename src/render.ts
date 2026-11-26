/**
 * TUI rendering for the `r` tool and for non-R `eval` cells, modelled on omp's `eval` cells: a
 * rounded frame with a header (status icon, title, duration), the highlighted code, and the
 * output in a section below it; collapsed output keeps a tail preview and ctrl+o expands it.
 *
 * omp 19.2 dropped the pi-tui component API from the extension surface: `@oh-my-pi/pi-tui` now
 * exports reactive nodes, and the string helpers moved to `@oh-my-pi/pi-tui/text/width`. A rows
 * object (`{ render(width) }`) is still the supported escape hatch, so the frame is drawn here
 * from the theme handed to the renderer plus those width helpers.
 */
import { highlightCode } from "@oh-my-pi/pi-coding-agent";
import { replaceTabs, spaces, truncate, visibleWidth, wrap } from "@oh-my-pi/pi-tui/text/width";

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

/** A rows object: the render contract still accepted from extension renderers. */
export interface Rows {
	render(width: number): readonly string[];
	invalidate?(): void;
}

/**
 * The extension theme omp hands to renderers: pi-tui's `Theme`, not the internal one.
 * It exposes semantic `fg`/`bgSgr` colors and a `symbols` bundle; `styledSymbol`, `boxRound`
 * and `getBgAnsi` from the built-in renderers are not part of it.
 */
interface Theme {
	fg(color: string, text: string): string;
	bgSgr(color: string): string;
	symbols: {
		box: { horizontal: string; vertical: string; topLeft: string; topRight: string; bottomLeft: string; bottomRight: string; teeRight: string; teeLeft: string };
		spinnerFrames: string[];
	};
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
			return theme.fg("success", "✔");
		case "error":
			return theme.fg("error", "✘");
		case "pending":
			return theme.fg("muted", "⏳");
		case "running": {
			const frames = theme.symbols.spinnerFrames;
			return frames.length > 0 ? frames[(spinnerFrame ?? 0) % frames.length] : theme.fg("accent", "…");
		}
	}
}

interface Section {
	label?: string;
	lines: string[];
}

/** Same layout as omp's `renderOutputBlock`: header bar, sections split by labelled bars, bottom bar. */
function frame(header: string, meta: string | undefined, state: State, sections: Section[], width: number, theme: Theme): string[] {
	const box = theme.symbols.box;
	const { horizontal: h, vertical: v } = box;
	const cap = h.repeat(3);
	const borderColor = state === "error" ? "error" : state === "running" || state === "pending" ? "accent" : "dim";
	const border = (text: string) => theme.fg(borderColor, text);
	const bgAnsi = theme.bgSgr(state === "success" ? "toolSuccessBg" : state === "error" ? "toolErrorBg" : "toolPendingBg");
	// Re-apply the background after inner SGR resets so it survives mid-line.
	const paint = (text: string) =>
		`${bgAnsi}${text.replace(/\x1b\[(?:0)?m/g, m => `${m}${bgAnsi}`).replace(/\x1b\[49m/g, m => `${m}${bgAnsi}`)}\x1b[49m`;
	const fit = (line: string) => paint(line + spaces(Math.max(0, width - visibleWidth(line))));

	const contentWidth = Math.max(1, width - 2 * visibleWidth(v) - 2);

	const bar = (left: string, right: string, label?: string): string => {
		const leftGlyphs = `${left}${cap}`;
		if (!label) {
			const fill = Math.max(0, width - visibleWidth(leftGlyphs) - visibleWidth(right));
			return `${border(leftGlyphs)}${border(h.repeat(fill))}${border(right)}`;
		}
		const trimmed = truncate(` ${label} `, Math.max(0, width - visibleWidth(leftGlyphs) - visibleWidth(right)));
		const fill = Math.max(0, width - visibleWidth(leftGlyphs) - visibleWidth(trimmed) - visibleWidth(right));
		return `${border(leftGlyphs)}${trimmed}${border(h.repeat(fill))}${border(right)}`;
	};

	const rows = [bar(box.topLeft, box.topRight, [header, meta].filter(Boolean).join(" · "))];
	for (const section of sections) {
		if (section.label) rows.push(bar(box.teeRight, box.teeLeft, section.label));
		for (const line of section.lines.flatMap(l => l.split("\n"))) {
			for (const wrapped of wrap(line.trimEnd(), contentWidth)) {
				// `wrap` breaks a styled line without closing its SGR; close it so the padding and
				// border take the border colour, not the last span's.
				rows.push(`${border(v)} ${wrapped}\x1b[0m${spaces(Math.max(0, contentWidth - visibleWidth(wrapped)))} ${border(v)}`);
			}
		}
	}
	rows.push(bar(box.bottomLeft, box.bottomRight));
	return rows.map(fit);
}

/** Carriage returns overwrite within a line (progress bars); keep only the final segment. Trailing CRs (CRLF) do not count. */
function cleanLine(line: string): string {
	const s = line.replace(/\r+$/, "");
	const i = s.lastIndexOf("\r");
	return replaceTabs(i < 0 ? s : s.slice(i + 1));
}

/** Tail of the visual rows after wrapping at `width`, for the collapsed preview. */
function tailVisualLines(text: string, maxLines: number, width: number): { visualLines: string[]; skippedCount: number } {
	if (!text) return { visualLines: [], skippedCount: 0 };
	const lines = text.split("\n").flatMap(line => wrap(line, width));
	if (lines.length <= maxLines) return { visualLines: lines, skippedCount: 0 };
	return { visualLines: lines.slice(-maxLines), skippedCount: lines.length - maxLines };
}

interface CellInput {
	/** Tool title drawn in the header ("R", "Eval"). */
	label: string;
	/** Dim text after the title: language and title of an eval cell. */
	subtitle?: string;
	code: string;
	/** Language token for the highlighter (omp's eval tokens differ: `js` -> `javascript`). */
	highlighter: string;
}

function cell(
	input: CellInput,
	state: State,
	options: RenderOptions,
	theme: Theme,
	width: number,
	result?: { output: string; durationMs?: number },
): string[] {
	const expanded = options.expanded === true;

	// Code: tail window while collapsed, so the newest line stays visible as it streams.
	const codeLines = input.code.split(/\r?\n/).map(cleanLine);
	const maxCode = expanded ? codeLines.length : Math.min(codeLines.length, previewWindowRows());
	const hiddenCode = codeLines.length - maxCode;
	const code = highlightCode(codeLines.slice(hiddenCode).join("\n"), input.highlighter || undefined, theme as never);
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
			const preview = tailVisualLines(styled, Math.min(PREVIEW_LINES, previewWindowRows()), Math.max(1, width - 4));
			lines = [...preview.visualLines];
			hidden = preview.skippedCount;
		}
		if (hidden > 0) lines.push(theme.fg("dim", `… ${hidden} more lines (ctrl+o to expand)`));
		sections.push({ label: theme.fg("toolTitle", "Output"), lines });
	}

	const icon = statusIcon(state, theme, options.spinnerFrame);
	const active = state === "pending" || state === "running" ? `${theme.fg("muted", state)} ` : "";
	const subtitle = input.subtitle ? ` ${theme.fg("dim", input.subtitle)}` : "";
	const header = `${icon} ${active}${theme.fg("toolTitle", input.label)}${subtitle}`;
	const meta = result?.durationMs !== undefined ? theme.fg("dim", `(${formatDuration(result.durationMs)})`) : undefined;
	return frame(header, meta, state, sections, width, theme);
}

/** Rows object with render caching: same key and width returns the same array, as the engine expects. */
function framed(key: () => string, build: (width: number) => string[]): Rows {
	let cached: { key: string; width: number; rows: string[] } | undefined;
	return {
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
}

function cacheKey(state: State, options: RenderOptions, extra: string): string {
	return `${options.expanded ? 1 : 0}|${options.spinnerFrame ?? "-"}|${previewWindowRows()}|${state}|${extra}`;
}

/** Renderers for the `r` tool. */
export function createRenderers() {
	function renderCall(args: RenderArgs, options: RenderOptions, theme: Theme): Rows {
		const code = args?.code ?? "";
		const state: State = options.spinnerFrame !== undefined ? "running" : "pending";
		return framed(
			() => cacheKey(state, options, `${code.length}`),
			width => cell({ label: "R", code, highlighter: "r" }, state, options, theme, width),
		);
	}

	function renderResult(result: RenderResult, options: RenderOptions, theme: Theme, args?: RenderArgs): Rows {
		const details = result.details;
		const output = (details?.output ?? result.content.find(c => c.type === "text")?.text ?? "").replace(/\s+$/, "");
		const notes = details?.notes ?? [];
		const state: State = options.isPartial ? "running" : result.isError ? "error" : "success";

		return framed(
			() => cacheKey(state, options, `${output.length}|${notes.length}`),
			width => {
				const rows = cell({ label: "R", code: args?.code ?? "", highlighter: "r" }, state, options, theme, width, {
					output,
					durationMs: options.isPartial ? undefined : details?.durationMs,
				});
				for (const note of notes) rows.push(truncate(theme.fg("dim", note), width));
				return rows;
			},
		);
	}

	return { renderCall, renderResult };
}

interface EvalArgs {
	code?: string;
	language?: string;
	title?: string;
}

/**
 * Renderers for py/js cells of a shadowed `eval`. omp 19.2 no longer exposes the native
 * `evalToolRenderer`, so these draw the same frame as R cells; the host still appends the result's
 * image blocks itself.
 */
export function createEvalRenderers() {
	const input = (args?: EvalArgs): CellInput => ({
		label: "Eval",
		subtitle: [args?.language, args?.title].filter(Boolean).join(" · ") || undefined,
		code: args?.code ?? "",
		highlighter: args?.language === "js" ? "javascript" : args?.language === "ruby" || args?.language === "julia" ? args.language : "python",
	});

	function renderCall(args: EvalArgs, options: RenderOptions, theme: Theme): Rows {
		const spec = input(args);
		const state: State = options.spinnerFrame !== undefined ? "running" : "pending";
		return framed(
			() => cacheKey(state, options, `${spec.subtitle ?? ""}|${spec.code.length}`),
			width => cell(spec, state, options, theme, width),
		);
	}

	function renderResult(result: RenderResult, options: RenderOptions, theme: Theme, args?: EvalArgs): Rows {
		const spec = input(args);
		const output = (result.details?.output ?? result.content.find(c => c.type === "text")?.text ?? "").replace(/\s+$/, "");
		const state: State = options.isPartial ? "running" : result.isError ? "error" : "success";
		return framed(
			() => cacheKey(state, options, `${spec.subtitle ?? ""}|${output.length}`),
			width => cell(spec, state, options, theme, width, { output }),
		);
	}

	return { renderCall, renderResult };
}
