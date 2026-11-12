export const DEFAULT_TIMEOUT_S = 120;

/** Model-facing description of the R session; shared by the `r` tool and the `eval` shadow. */
export function describe(idleMinutes: number): string {
	const idle = idleMinutes > 0 ? `\n- The R process stops after ${idleMinutes} min without calls.` : "";
	return `Run R code in a persistent R session (statistical analysis, modelling, data wrangling, plots).

- Objects, loaded packages and options persist across calls until \`reset: true\` or the R process stops.
- Plots are returned as PNG images (at most 8 per call).
- An error aborts only that call; the session survives.
- Runs in the session's working directory. Files the call creates or modifies there are listed after the output.
- On timeout or cancel R is interrupted like Ctrl-C and keeps its objects. If it ignores the interrupt for 2 s it is killed and every object is lost; this happens with code that swallows interrupts (\`tryCatch(..., interrupt=)\`), loops forever, or reads stdin (\`readLines("stdin")\`, \`scan()\`). Save costly objects with \`saveRDS()\` before long or risky code, and set a \`timeout\` longer than the expected run.${idle}
- Do not write comments in R code.`;
}

/** Compact R notes appended to the native `eval` description (kept short: eval is always in the prompt). */
export function describeForEval(idleMinutes: number): string {
	const idle = idleMinutes > 0 ? ` The R process stops after ${idleMinutes} min without calls.` : "";
	return `Persistent R session for statistics, modelling and plots. Objects, packages and options persist until \`reset: true\` or the process stops; plots return as PNG.
- An error aborts only that cell. Files the cell writes in the session cwd are listed after the output.
- On timeout/cancel R is interrupted like Ctrl-C and keeps its objects; code that swallows interrupts (\`tryCatch(..., interrupt=)\`), never returns, or reads stdin (\`readLines("stdin")\`, \`scan()\`) gets killed and loses them, so \`saveRDS()\` costly objects first.${idle}
- Do not write comments in R code.`;
}
