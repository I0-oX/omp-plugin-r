import type { ExtensionAPI, ExtensionContext } from "@oh-my-pi/pi-coding-agent";
import { findChangedFiles } from "./changed-files";
import { DEFAULT_TIMEOUT_S, describe, describeForEval } from "./description";
import { shadowEval } from "./eval-shadow";
import { findR, rEngine } from "./r";
import { createRenderers, type RDetails } from "./render";
import { EngineUnavailable, Session, SessionLost } from "./session";

const DEFAULT_IDLE_MINUTES = 30;
const MAX_PLOTS = 8;
const MAX_FILES_SHOWN = 20;
const UPDATE_INTERVAL_MS = 100;

interface RParams {
	code: string;
	timeout?: number;
	reset?: boolean;
}

async function filesLine(cwd: string, startedAt: number | undefined): Promise<{ line?: string; files: string[] }> {
	if (startedAt === undefined) return { files: [] };
	const { paths, partial } = await findChangedFiles(cwd, startedAt);
	if (paths.length === 0) return { files: [] };
	const shown = paths.slice(0, MAX_FILES_SHOWN).join(", ");
	const more = paths.length > MAX_FILES_SHOWN ? ` (+${paths.length - MAX_FILES_SHOWN} more)` : "";
	const scan = partial ? " (partial scan of a large directory)" : "";
	return { line: `[files written: ${shown}${more}${scan}]`, files: paths };
}

export default function statsPlugin(pi: ExtensionAPI) {
	// Unavailable interpreter: register nothing rather than advertise a tool that cannot work.
	if (!findR()) return;

	const configured = Number(process.env.OMP_R_IDLE_MINUTES || DEFAULT_IDLE_MINUTES);
	const idleMinutes = Number.isFinite(configured) && configured >= 0 ? configured : DEFAULT_IDLE_MINUTES;
	const z = pi.zod;
	const sessions = new Map<string, Session>();

	async function executeR(
		params: RParams,
		signal: AbortSignal | undefined,
		onUpdate: ((partial: { content: { type: "text"; text: string }[]; details: RDetails }) => void) | undefined,
		ctx: Pick<ExtensionContext, "cwd" | "sessionManager">,
	) {
		const id = ctx.sessionManager.getSessionId();
		let session = sessions.get(id);
		if (!session) {
			session = new Session(rEngine, { idleMs: idleMinutes * 60_000 });
			sessions.set(id, session);
		}
		if (params.reset) session.reset();

		const startedMs = Date.now();
		let lastUpdate = 0;
		try {
			const result = await session.run(params.code, {
				cwd: ctx.cwd,
				signal,
				timeoutMs: (params.timeout ?? DEFAULT_TIMEOUT_S) * 1000,
				onOutput: text => {
					const now = Date.now();
					if (now - lastUpdate < UPDATE_INTERVAL_MS) return;
					lastUpdate = now;
					onUpdate?.({ content: [{ type: "text", text }], details: { output: text } satisfies RDetails });
				},
			});

			const output = result.output.replace(/\n+$/, "");
			const notes = [...result.notices];
			if (result.interrupted) {
				notes.push(`[${result.interrupted}; R was interrupted and kept its objects]`);
			} else if (result.status !== 0) {
				notes.push("[R reported an error; the session is still alive]");
			}
			const shown = result.plots.slice(0, MAX_PLOTS);
			if (result.plots.length > shown.length) {
				notes.push(`[${result.plots.length - shown.length} further plot(s) not shown]`);
			}
			const { line, files } = await filesLine(ctx.cwd, result.startedAt);
			if (line) notes.push(line);
			const text = [
				...result.notices,
				result.output.trim() === "" ? "(no output)" : output,
				...notes.slice(result.notices.length),
			].join("\n");
			const details: RDetails = {
				output: result.output.trim() === "" ? "" : output,
				notes,
				durationMs: Date.now() - startedMs,
				status: result.status,
				plots: result.plots.length,
				files,
				interrupted: result.interrupted,
			};
			return {
				content: [
					{ type: "text" as const, text },
					...shown.map(png => ({ type: "image" as const, data: png.toString("base64"), mimeType: "image/png" })),
				],
				details,
				isError: result.status !== 0 || result.interrupted !== undefined,
			};
		} catch (err) {
			if (err instanceof SessionLost) {
				const output = err.output.trim();
				const notes = [`${err.message}. The R session was discarded; its objects are gone.`];
				const { line, files } = await filesLine(ctx.cwd, err.startedAt);
				if (line) notes.push(line);
				const details: RDetails = { output, notes, durationMs: Date.now() - startedMs, files };
				return {
					content: [{ type: "text" as const, text: [...(output ? [output] : []), ...notes].join("\n") }],
					details,
					isError: true,
				};
			}
			if (err instanceof EngineUnavailable) {
				const details: RDetails = { notes: [err.message], durationMs: Date.now() - startedMs };
				return { content: [{ type: "text" as const, text: err.message }], details, isError: true };
			}
			throw err;
		}
	}

	const renderers = createRenderers(pi.pi as never);

	function registerRTool() {
		pi.registerTool({
			name: "r",
			label: "R",
			description: describe(idleMinutes),
			approval: "exec",
			parameters: z.object({
				code: z.string().describe("R code to run; may span multiple lines"),
				timeout: z
					.number()
					.min(0)
					.optional()
					.describe(`Seconds before the call is interrupted (default ${DEFAULT_TIMEOUT_S}, 0 = no limit)`),
				reset: z.boolean().optional().describe("Discard the existing R session (all objects) before running"),
			}),

			async execute(_toolCallId, params, signal, onUpdate, ctx) {
				return executeR(params, signal, onUpdate, ctx);
			},

			...renderers,
			// Not in the public ToolDefinition type, but honoured by omp's tool proxy: once the result
			// exists it draws the whole cell (code included) and the call preview is dropped, as for eval.
			...({ mergeCallAndResult: true } as object),
		});
	}

	// R is exposed as `eval` language "r" when the built-in eval can be shadowed, and as a separate
	// `r` tool otherwise. Never both: two entry points would put two descriptions in the prompt.
	let exposed = false;
	pi.on("session_start", async (_event, ctx) => {
		if (exposed) return;
		exposed = true;
		let shadowed = false;
		try {
			shadowed = await shadowEval(pi, ctx, {
				executeR,
				rDescription: describeForEval(idleMinutes),
				defaultTimeoutS: DEFAULT_TIMEOUT_S,
				renderers: renderers as never,
			});
		} catch (err) {
			if (ctx.hasUI) ctx.ui.notify(`omp-plugin-r: eval shadow failed (${err}); using the r tool`, "warning");
		}
		if (!shadowed) registerRTool();
	});

	pi.on("session_shutdown", (_event, ctx) => {
		const id = ctx.sessionManager.getSessionId();
		sessions.get(id)?.kill();
		sessions.delete(id);
	});
}
