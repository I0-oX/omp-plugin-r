import { accessSync, constants } from "node:fs";
import { writeFile } from "node:fs/promises";
import { delimiter, join } from "node:path";
import { type Engine, EngineUnavailable } from "./session";

function isExecutable(path: string): boolean {
	try {
		accessSync(path, constants.X_OK);
		return true;
	} catch {
		return false;
	}
}

/** Locate an executable on PATH (honours PATHEXT on Windows). */
function findOnPath(name: string): string | undefined {
	const exts = process.platform === "win32" ? (process.env.PATHEXT ?? ".EXE;.CMD;.BAT").split(";") : [""];
	for (const dir of (process.env.PATH ?? "").split(delimiter)) {
		for (const ext of exts) {
			const candidate = join(dir, name + ext);
			if (isExecutable(candidate)) return candidate;
		}
	}
	return undefined;
}

/** Path of the R binary: `$R_BIN` if it is executable, else `R` on PATH. */
export function findR(): string | undefined {
	const override = process.env.R_BIN;
	if (override) return isExecutable(override) ? override : undefined;
	return findOnPath("R");
}

/**
 * Sourced once per R process. `.omp_run(ctl)` reads four lines from the control file
 * (script, token, plot dir, hex-encoded cwd), sources the script with auto-printing,
 * converts errors and warnings to text, then prints the end marker. The cwd is hex
 * encoded because the file is line-based and a directory name may contain any byte.
 * Plot files carry a session-wide counter so a user-issued `dev.off()` never makes a
 * later plot overwrite an earlier one.
 *
 * The helpers live in an environment attached to the search path rather than in the
 * global environment, so `rm(list = ls(all.names = TRUE))` in user code cannot delete
 * them. Any `sink()` the user left open is closed before output is written, otherwise
 * the end marker would vanish into the sink file.
 */
const BOOTSTRAP = String.raw`
options(width = 100, warn = 1, device = NULL)
if (!isTRUE(l10n_info()[["UTF-8"]])) invisible(try(Sys.setlocale("LC_CTYPE", "C.UTF-8"), silent = TRUE))
sink(stdout(), type = "message")
local({
  omp <- new.env()
  omp$plots <- 0L
  omp$unsink <- function() while (sink.number() > 0L) sink()
  omp$fmt <- function(kind, cnd) {
    call <- conditionCall(cnd)
    where <- if (is.null(call)) "" else paste(deparse(call, nlines = 1L), collapse = " ")
    if (nzchar(where) && !startsWith(where, "eval(ei")) {
      paste0(kind, " in ", where, " : ", conditionMessage(cnd))
    } else {
      paste0(kind, ": ", conditionMessage(cnd))
    }
  }
  omp$unhex <- function(h) {
    pos <- seq(1L, nchar(h), by = 2L)
    s <- rawToChar(as.raw(strtoi(substring(h, pos, pos + 1L), 16L)))
    Encoding(s) <- "UTF-8"
    s
  }
  omp$.omp_run <- function(ctl) {
    a <- readLines(ctl, encoding = "UTF-8", warn = FALSE)
    status <- 0L
    cwd <- omp$unhex(a[4])
    omp$plotdir <- a[3]
    moved <- tryCatch({ setwd(cwd); TRUE }, error = function(e) FALSE)
    if (moved) {
      options(device = function(...) {
        omp$plots <- omp$plots + 1L
        png(filename = file.path(omp$plotdir, sprintf("plot-%04d-%%03d.png", omp$plots)),
            width = 900, height = 600, res = 110)
      })
      tryCatch(
        withCallingHandlers(
          source(a[1], local = globalenv(), echo = FALSE, print.eval = TRUE, keep.source = FALSE),
          warning = function(w) {
            cat(omp$fmt("Warning", w), "\n", sep = "")
            invokeRestart("muffleWarning")
          }),
        error = function(e) {
          omp$unsink()
          cat(omp$fmt("Error", e), "\n", sep = "")
          status <<- 1L
        })
    } else {
      cat("Error: cannot change working directory to '", cwd, "'\n", sep = "")
      status <- 1L
    }
    omp$unsink()
    graphics.off()
    cat("\n", sprintf("<<OMP-END %s %d>>", a[2], status), "\n", sep = "")
    flush(stdout())
    invisible(NULL)
  }
  attach(omp, name = "omp-plugin", warn.conflicts = FALSE)
})
`;

export const rEngine: Engine = {
	name: "R",
	scriptExt: ".R",
	bootstrap: BOOTSTRAP,

	command() {
		const cmd = findR();
		if (!cmd) throw new EngineUnavailable("R was not found on PATH (set R_BIN to an executable R binary).");
		return { cmd, args: ["--vanilla", "--no-echo", "--no-save", "--no-restore"] };
	},

	async stdinFor(run) {
		const ctl = join(run.dir, "ctl.txt");
		const cwdHex = Buffer.from(run.cwd, "utf8").toString("hex");
		await writeFile(ctl, [run.script, run.token, run.plotDir, cwdHex].join("\n"), "utf8");
		return `.omp_run(${JSON.stringify(ctl)})\n`;
	},
};
