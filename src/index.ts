import type { ExtensionAPI } from "@oh-my-pi/pi-coding-agent";
import { findR, rEngine } from "./r";
import { EngineUnavailable, Session, SessionLost } from "./session";

const DEFAULT_TIMEOUT_S = 120;
// setTimeout overflows (fires after ~1 ms) above 2^31-1 ms, so larger values would kill the session at once.
const MAX_TIMEOUT_S = 2_147_483;
const MAX_PLOTS = 8;
const UPDATE_INTERVAL_MS = 100;

const DESCRIPTION = `Run R code in a persistent R session (statistical analysis, modelling, data wrangling, plots).

- State persists across calls: objects, loaded packages and options stay in the global environment until \`reset: true\`, a timeout/cancel, or the session ends.
- Top-level values auto-print as in the R console (\`summary(fit)\`, a data.frame, a ggplot).
- Plots (base graphics, ggplot2, lattice) are returned as PNG images. Use \`ggsave\`/\`png()\` yourself if you need files on disk.
- Warnings and errors come back as text. An error aborts only that call; the session survives.
- Runs in the session's working directory, so relative paths (\`read.csv("data.csv")\`) work. Move data between R and other tools through files.
- \`timeout\` is in seconds (default ${DEFAULT_TIMEOUT_S}, 0 = none). A timeout or cancellation kills the R process and loses its state; the next call starts a fresh session and says so.
- R's stdin is the tool's control channel: do not read from stdin (\`readLines("stdin")\`, \`scan()\`).`;

export default function statsPlugin(pi: ExtensionAPI) {
	// Unavailable interpreter: register nothing rather than advertise a tool that cannot work.
	if (!findR()) return;

	const z = pi.zod;
	const sessions = new Map<string, Session>();

	pi.registerTool({
		name: "r",
		label: "R",
		description: DESCRIPTION,
		loadMode: "essential",
		approval: "exec",
		parameters: z.object({
			code: z.string().describe("R code to run; may span multiple lines"),
			timeout: z
				.number()
				.min(0)
				.max(MAX_TIMEOUT_S)
				.optional()
				.describe(`Seconds before the call is aborted (default ${DEFAULT_TIMEOUT_S}, 0 = no limit)`),
			reset: z.boolean().optional().describe("Discard the existing R session (all objects) before running"),
		}),

		async execute(_toolCallId, params, signal, onUpdate, ctx) {
			const id = ctx.sessionManager.getSessionId();
			let session = sessions.get(id);
			if (!session) {
				session = new Session(rEngine);
				sessions.set(id, session);
			}
			if (params.reset) session.reset();

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
						onUpdate?.({ content: [{ type: "text", text }], details: {} });
					},
				});

				const parts = [...result.notices];
				parts.push(result.output.trim() === "" ? "(no output)" : result.output.replace(/\n+$/, ""));
				if (result.status !== 0) parts.push("[R reported an error; the session is still alive]");
				const shown = result.plots.slice(0, MAX_PLOTS);
				if (result.plots.length > shown.length) {
					parts.push(`[${result.plots.length - shown.length} further plot(s) not shown]`);
				}
				return {
					content: [
						{ type: "text", text: parts.join("\n") },
						...shown.map(png => ({ type: "image" as const, data: png.toString("base64"), mimeType: "image/png" })),
					],
					details: { status: result.status, plots: result.plots.length },
					isError: result.status !== 0,
				};
			} catch (err) {
				if (err instanceof SessionLost) {
					const text = err.output.trim();
					const lost = `${err.message}. The R session was discarded; its objects are gone.`;
					return { content: [{ type: "text", text: text ? `${text}\n${lost}` : lost }], details: {}, isError: true };
				}
				if (err instanceof EngineUnavailable) {
					return { content: [{ type: "text", text: err.message }], details: {}, isError: true };
				}
				throw err;
			}
		},
	});

	pi.on("session_shutdown", (_event, ctx) => {
		const id = ctx.sessionManager.getSessionId();
		sessions.get(id)?.kill();
		sessions.delete(id);
	});
}
