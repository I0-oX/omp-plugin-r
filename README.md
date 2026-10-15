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

Requires `R` on `PATH` (or set `R_BIN` to the binary). If R is not found the plugin registers nothing, so no dead tool is advertised.

## The `r` tool

| Parameter | Description |
| --- | --- |
| `code` | R code to run; may span multiple lines. |
| `timeout` | Seconds before the call is aborted. Default 120, `0` = no limit. |
| `reset` | Discard the existing R session before running. |

- **State persists** across calls: objects, loaded packages, options.
- **Auto-print** like the console: `summary(fit)`, data frames, ggplot objects.
- **Plots** (base, ggplot2, lattice) are returned as PNG images. Each plot gets a session-wide unique name, so `dev.off()` never makes a later plot overwrite an earlier one.
- **Errors and warnings** come back as text; an error aborts only that call.
- Runs in the session's working directory, so `read.csv("data.csv")` works. Move data between R and other tools through files.
- One R process per omp session, cells run one at a time, and the process is killed on `session_shutdown` (and when omp exits).

### Cancellation and timeouts

A cancelled or timed-out call kills the R process: a computation in flight cannot be re-synchronised with the control channel. The call returns whatever output was produced, and the next call starts a fresh session and says so, so state is lost. Use `timeout: 0` only for work you are happy to wait for.

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

`test/session.test.ts` exercises the protocol against a fake `sh` engine; `test/r.test.ts` runs against real R and is skipped when R is absent.

## Not included

Stata is not supported yet. The session layer (`src/session.ts`) is engine-agnostic, so another stdin-driven interpreter would be an `Engine` definition plus a tool registration.
