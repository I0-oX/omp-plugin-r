import { accessSync, constants } from "node:fs";
import { writeFile } from "node:fs/promises";
import { delimiter, join } from "node:path";
import { type Engine, EngineUnavailable } from "./session";

/** Locate an executable on PATH (honours PATHEXT on Windows). */
function findOnPath(name: string): string | undefined {
	const exts = process.platform === "win32" ? (process.env.PATHEXT ?? ".EXE;.CMD;.BAT").split(";") : [""];
	for (const dir of (process.env.PATH ?? "").split(delimiter)) {
		for (const ext of exts) {
			const candidate = join(dir, name + ext);
			try {
				accessSync(candidate, constants.X_OK);
				return candidate;
			} catch {
				// not here
			}
		}
	}
	return undefined;
}

/** Path of the R binary: `$R_BIN`, else `R` on PATH. */
export function findR(): string | undefined {
	return process.env.R_BIN || findOnPath("R");
}

/**
 * Sourced once per R process. `.omp_run(ctl)` reads four lines from the control file
 * (script, cwd, token, plot dir), sources the script with auto-printing, converts errors
 * and warnings to text, then prints the end marker. Plot files carry a session-wide
 * counter so a user-issued `dev.off()` never makes a later plot overwrite an earlier one.
 */
const BOOTSTRAP = String.raw`
options(width = 100, warn = 1, device = NULL)
if (!isTRUE(l10n_info()[["UTF-8"]])) invisible(try(Sys.setlocale("LC_CTYPE", "C.UTF-8"), silent = TRUE))
sink(stdout(), type = "message")
.omp <- new.env()
.omp$plots <- 0L
.omp_fmt <- function(kind, cnd) {
  call <- conditionCall(cnd)
  where <- if (is.null(call)) "" else paste(deparse(call, nlines = 1L), collapse = " ")
  if (nzchar(where) && !startsWith(where, "eval(ei")) {
    paste0(kind, " in ", where, " : ", conditionMessage(cnd))
  } else {
    paste0(kind, ": ", conditionMessage(cnd))
  }
}
.omp_run <- function(ctl) {
  a <- readLines(ctl, encoding = "UTF-8", warn = FALSE)
  status <- 0L
  try(setwd(a[2]), silent = TRUE)
  .omp$plotdir <- a[4]
  options(device = function(...) {
    .omp$plots <- .omp$plots + 1L
    png(filename = file.path(.omp$plotdir, sprintf("plot-%04d-%%03d.png", .omp$plots)),
        width = 900, height = 600, res = 110)
  })
  tryCatch(
    withCallingHandlers(
      source(a[1], local = globalenv(), echo = FALSE, print.eval = TRUE, keep.source = FALSE),
      warning = function(w) {
        cat(.omp_fmt("Warning", w), "\n", sep = "")
        invokeRestart("muffleWarning")
      }),
    error = function(e) {
      cat(.omp_fmt("Error", e), "\n", sep = "")
      status <<- 1L
    })
  graphics.off()
  cat("\n", sprintf("<<OMP-END %s %d>>", a[3], status), "\n", sep = "")
  flush(stdout())
  invisible(NULL)
}
`;

export const rEngine: Engine = {
	name: "R",
	scriptExt: ".R",
	bootstrap: BOOTSTRAP,

	command() {
		const cmd = findR();
		if (!cmd) throw new EngineUnavailable("R was not found on PATH (set R_BIN to its location).");
		return { cmd, args: ["--vanilla", "--no-echo", "--no-save", "--no-restore"] };
	},

	async stdinFor(run) {
		const ctl = join(run.dir, "ctl.txt");
		await writeFile(ctl, [run.script, run.cwd, run.token, run.plotDir].join("\n"), "utf8");
		return `.omp_run(${JSON.stringify(ctl)})\n`;
	},
};
