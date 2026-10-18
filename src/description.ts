export const DEFAULT_TIMEOUT_S = 120;

/** Model-facing description of the R session; shared by the `r` tool and the `eval` shadow. */
export function describe(idleMinutes: number): string {
	const idle = idleMinutes > 0 ? `\n- The R process stops after ${idleMinutes} min without calls.` : "";
	return `Run R code in a persistent R session (statistical analysis, modelling, data wrangling, plots).

- State persists across calls: objects, loaded packages and options stay in the global environment until \`reset: true\` or the R process stops.
- Top-level values auto-print as in the R console (\`summary(fit)\`, a data.frame, a ggplot).
- Plots (base graphics, ggplot2, lattice) are returned as PNG images. Use \`ggsave\`/\`png()\` yourself if you need files on disk.
- Warnings and errors come back as text. An error aborts only that call; the session survives.
- Runs in the session's working directory, so relative paths (\`read.csv("data.csv")\`) work. Files the call creates or modifies there are listed after the output.
- \`timeout\` is in seconds (default ${DEFAULT_TIMEOUT_S}, 0 = none). On timeout or cancel R is interrupted like Ctrl-C and keeps its objects; code that ignores the interrupt for 2 s is killed and its objects are lost.${idle}
- Whenever the R process was lost, the next call says so.
- Never write code that swallows interrupts (\`tryCatch(..., interrupt=)\`) or loops forever: a timeout then kills R and every object is lost. Save costly objects with \`saveRDS()\` before long or risky code, and use a \`timeout\` longer than the expected run.
- R's stdin is the tool's control channel: do not read from stdin (\`readLines("stdin")\`, \`scan()\`).`;
}

/** Compact R notes appended to the native `eval` description (kept short: eval is always in the prompt). */
export function describeForEval(idleMinutes: number): string {
	const idle = idleMinutes > 0 ? ` The R process stops after ${idleMinutes} min without calls.` : "";
	return `Persistent R session for statistics, modelling and plots. State (objects, packages, options) persists until \`reset: true\` or the process stops; top-level values auto-print like the console; plots (base, ggplot2, lattice) return as PNG.
- Errors/warnings come back as text and abort only that cell. Runs in the session cwd; files the cell writes are listed after the output.
- \`timeout\` default ${DEFAULT_TIMEOUT_S} s. On timeout/cancel R is interrupted like Ctrl-C and keeps its objects; code that swallows interrupts (\`tryCatch(..., interrupt=)\`) or never returns gets killed and loses them, so \`saveRDS()\` costly objects first.${idle} A lost process is reported on the next call.
- Never read stdin (\`readLines("stdin")\`, \`scan()\`).`;
}
