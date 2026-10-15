# omp-plugin-r

An [omp](https://omp.sh) plugin that gives the agent a persistent **R** session as an `r` tool, for statistical analysis, modelling and plotting.

omp's `eval` tool has no extension point for new languages, so this ships as an extension that registers its own tool instead.

## Install

```sh
omp plugin install github:I0-oX/omp-plugin-r
```

or, from a local checkout:

```sh
omp plugin link /path/to/omp-plugin-r
```

Requires `R` on `PATH` (or set `R_BIN` to an executable R binary). If R is not found the plugin registers nothing, so no dead tool is advertised.

The tool is discoverable rather than always loaded: with omp's `tools.xdev` on (the default) the model reaches it as `xd://r`, so its description only costs prompt space when R is used.

### Configuration

| Environment variable | Default | Meaning |
| --- | --- | --- |
| `R_BIN` | `R` on `PATH` | R binary to run. |
| `OMP_R_IDLE_MINUTES` | `30` | Stop the R process after this many minutes without calls; `0` = never. |

## The `r` tool

| Parameter | Description |
| --- | --- |
| `code` | R code to run; may span multiple lines. |
| `timeout` | Seconds before the call is interrupted. Default 120, `0` = no limit. |
| `reset` | Discard the existing R session before running. |

- **State persists** across calls: objects, loaded packages, options.
- **Auto-print** like the console: `summary(fit)`, data frames, ggplot objects.
- **Plots** (base, ggplot2, lattice) are returned as PNG images. Each plot gets a session-wide unique name, so `dev.off()` never makes a later plot overwrite an earlier one.
- **Errors and warnings** come back as text; an error aborts only that call.
- Runs in the session's working directory, so `read.csv("data.csv")` works. Files the call creates or modifies there are listed after the output (`[files written: out.csv]`), skipping dot-directories, `node_modules`, `renv` and similar, with the scan capped at 5000 entries.
- One R process per omp session, cells run one at a time. The process stops after `OMP_R_IDLE_MINUTES` without calls, on `session_shutdown`, and when omp exits. Whenever it was lost, the next call says so.

### Cancellation and timeouts

On timeout or cancel R is interrupted with SIGINT, like Ctrl-C. Interrupts are checked by `Sys.sleep`, interpreted loops and most R code, so the cell stops at once: the call returns what was produced and the session keeps its objects. Code that does not respond within 2 s (long compiled routines, code that swallows interrupts) is killed; its objects are lost and the next call says so.

### Limits

- R's stdin is the tool's control channel. Code that reads stdin (`scan()`, `readLines("stdin")`) blocks until the timeout. `readline()` is harmless.
- Output is bounded to roughly the first 16k and last 32k characters; the middle is elided with a note.
- The tool has `approval: "exec"`: R can run arbitrary code (`system()`), so it is gated like `bash`.

## How it works

Each cell is written to a temp file and the R process, started once with `R --vanilla --no-echo`, is told to `source()` it with `print.eval = TRUE`. R then prints an end marker `<<OMP-END <token> <status>>>` carrying a random per-run token; the host streams output until it sees that exact token, so user output (or an echoed command) that merely looks like a marker is never mistaken for the end of a cell. Paths and the working directory travel in a control file rather than inside R source, so unusual directory names cannot break quoting.

## Development

```sh
bun test
```

`test/session.test.ts` exercises the protocol against a fake `sh` engine; `test/changed-files.test.ts` covers the written-files scan; `test/r.test.ts` runs against real R and is skipped when R is absent.

## Not included

Stata is not supported yet. The session layer (`src/session.ts`) is engine-agnostic, so another stdin-driven interpreter would be an `Engine` definition plus a tool registration.
