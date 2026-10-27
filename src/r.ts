import { accessSync, constants, statSync } from "node:fs";
import { writeFile } from "node:fs/promises";
import { delimiter, join } from "node:path";
import { type Engine, EngineUnavailable } from "./session";

function isExecutable(path: string): boolean {
	try {
		accessSync(path, constants.X_OK);
		if (!statSync(path).isFile()) return false;
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
 * The helpers are reached through `getOption(".omp")` rather than the global environment
 * or the search path, so `rm(list = ls(all.names = TRUE))` or `detach()` in user code
 * cannot remove them. Any `sink()` the user left open is closed before output is written,
 * otherwise the end marker would vanish into the sink file.
 */
const BOOTSTRAP = String.raw`
options(width = 100, warn = 1, device = NULL)
if (!isTRUE(l10n_info()[["UTF-8"]])) invisible(try(Sys.setlocale("LC_CTYPE", "C.UTF-8"), silent = TRUE))
sink(stdout(), type = "message")
local({
  omp <- new.env()
  omp$plots <- 0L
  omp$unsink <- function() {
    while (sink.number() > 0L) sink()
    sink(stdout(), type = "message")
  }
  # Prints the end marker once per token: from on.exit, or from the outer interrupt
  # handler when an interrupt lands before on.exit is registered. The token is recorded
  # only after the marker is out, so an interrupt that unwinds the cleanup half way still
  # gets the marker from the outer handler; suspendInterrupts keeps the cleanup itself whole.
  omp$end <- function(token, status) {
    if (identical(omp$last, token)) return(invisible(NULL))
    suspendInterrupts({
      omp$unsink()
      omp$closeDevices()
      cat("\n", sprintf("<<OMP-END %s %d>>", token, status), "\n", sep = "")
      flush(stdout())
      omp$last <- token
    })
    invisible(NULL)
  }
  # Closes only the devices opened by the plugin's png device, so a pdf() or svg() the
  # user keeps open across calls stays open.
  omp$devs <- integer()
  omp$closeDevices <- function() {
    open <- dev.list()
    for (d in omp$devs) {
      i <- match(d, open)
      if (!is.na(i) && identical(names(open)[i], "png")) dev.off(d)
    }
    omp$devs <- integer()
  }
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
  omp$run <- function(ctl) {
    a <- readLines(ctl, encoding = "UTF-8", warn = FALSE)
    status <- 0L
    on.exit(omp$end(a[2], status))
    cwd <- omp$unhex(a[4])
    omp$plotdir <- a[3]
    moved <- tryCatch({ setwd(cwd); TRUE }, error = function(e) FALSE)
    if (moved) {
      options(device = function(...) {
        omp$plots <- omp$plots + 1L
        png(filename = file.path(omp$plotdir, sprintf("plot-%04d-%%03d.png", omp$plots)),
            width = 900, height = 600, res = 110)
        omp$devs <- c(omp$devs, dev.cur())
      })
      tryCatch(
        withCallingHandlers(
          source(a[1], local = globalenv(), echo = FALSE, print.eval = TRUE, keep.source = FALSE),
          warning = function(w) {
            # Honour options(warn): -1 silences, >= 2 lets R turn the warning into an error.
            # Written to stderr (the message sink), so a user capture.output()/sink() does not swallow it.
            level <- getOption("warn", 0L)
            if (level >= 2L) return()
            if (level >= 0L) cat(omp$fmt("Warning", w), "\n", sep = "", file = stderr())
            invokeRestart("muffleWarning")
          }),
        error = function(e) {
          omp$unsink()
          cat(omp$fmt("Error", e), "\n", sep = "")
          status <<- 1L
        },
        interrupt = function(i) status <<- 1L)
    } else {
      cat("Error: cannot change working directory to '", cwd, "'\n", sep = "")
      status <- 1L
    }
    invisible(NULL)
  }
  # data.frames print as a compact typed table (column names, <type> row, rule, rows, row count),
  # like a notebook table. Anything unusual (extra print args, subclasses such as tibble, list or
  # matrix columns, custom row names, wider than options(width)) goes to base R's own method.
  omp$orig_df <- get("print.data.frame", envir = baseenv())
  omp$type <- function(col) {
    if (is.factor(col)) "fct"
    else if (inherits(col, "Date")) "date"
    else if (inherits(col, "POSIXct")) "dttm"
    else if (is.integer(col)) "int"
    else if (is.double(col)) "dbl"
    else if (is.character(col)) "chr"
    else if (is.logical(col)) "lgl"
    else "?"
  }
  omp$print_df <- function(x, ...) {
    plain <- nargs() == 1L && identical(class(x), "data.frame") && ncol(x) > 0L && nrow(x) > 0L &&
      .row_names_info(x) < 0L && all(vapply(x, function(col) !is.matrix(col) && !is.list(col), NA))
    if (plain) {
      types <- paste0("<", vapply(x, omp$type, ""), ">")
      shown <- min(nrow(x), 20L)
      cells <- lapply(x, function(col) format(col[seq_len(shown)], justify = "right"))
      w <- pmax(nchar(names(x), type = "width"), nchar(types, type = "width"),
                vapply(cells, function(cl) max(nchar(cl, type = "width")), 1L))
      if (sum(w) + 2L * (length(w) - 1L) <= getOption("width", 80L)) {
        pad <- function(s, k) paste0(strrep(" ", pmax(0L, k - nchar(s, type = "width"))), s)
        line <- function(v) paste(mapply(pad, v, w), collapse = "  ")
        cat(line(names(x)), "\n", line(types), "\n",
            strrep(intToUtf8(9472L), sum(w) + 2L * (length(w) - 1L)), "\n", sep = "")
        for (i in seq_len(shown)) cat(line(vapply(cells, function(cl) cl[i], "")), "\n", sep = "")
        cat(if (nrow(x) > shown) sprintf("... %d more rows, %d rows total", nrow(x) - shown, nrow(x))
            else sprintf("%d row%s", nrow(x), if (nrow(x) == 1L) "" else "s"), "\n", sep = "")
        return(invisible(x))
      }
    }
    omp$orig_df(x, ...)
  }
  # S3 dispatch finds base's own print.data.frame before any registered method, so replace the binding.
  local({
    unlockBinding("print.data.frame", baseenv())
    assign("print.data.frame", omp$print_df, envir = baseenv())
    lockBinding("print.data.frame", baseenv())
  })
  # Reached through an option, not the search path, so detach() or rm() in user code cannot remove it.
  options(.omp = omp)
})
# Force R's lazy loading of the code a cell touches now: an interrupt that lands inside a lazy-load
# promise leaves it broken ("promise already under evaluation") for the rest of the session.
invisible(capture.output(withCallingHandlers(tryCatch(
  source(exprs = quote({ 1 + 1; print(data.frame(a = 1L)); Sys.sleep(0) }), local = globalenv(), echo = FALSE, print.eval = TRUE, keep.source = FALSE),
  error = function(e) NULL, warning = function(w) NULL), warning = function(w) invokeRestart("muffleWarning"))))
cat("<<OMP-READY>>\n")
flush(stdout())
`;

export const rEngine: Engine = {
	name: "R",
	scriptExt: ".R",
	bootstrap: BOOTSTRAP,
	ready: "<<OMP-READY>>",

	command() {
		const cmd = findR();
		if (!cmd) throw new EngineUnavailable("R was not found on PATH (set R_BIN to an executable R binary).");
		// English R messages: LANGUAGE=en wins over a translated LC_ALL on glibc (checked with de_DE.UTF-8);
		// other platforms are untested. LC_CTYPE is left alone so UTF-8 output keeps working.
		return {
			cmd,
			args: ["--vanilla", "--no-echo", "--no-save", "--no-restore"],
			env: { LANGUAGE: "en", LC_MESSAGES: "C" },
		};
	},

	async stdinFor(run) {
		const ctl = join(run.dir, "ctl.txt");
		const cwdHex = Buffer.from(run.cwd, "utf8").toString("hex");
		await writeFile(ctl, [run.script, run.token, run.plotDir, cwdHex].join("\n"), "utf8");
		// Interrupts that land outside the cell must not reach the top level, where
		// non-interactive R would exit; the handler still ends the cell with its marker.
		const omp = 'getOption(".omp")';
		return `tryCatch(${omp}$run(${JSON.stringify(ctl)}), interrupt = function(i) ${omp}$end("${run.token}", 1L))\n`;
	},
};
