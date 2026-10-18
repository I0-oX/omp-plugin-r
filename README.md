# omp-plugin-r

An [omp](https://omp.sh) plugin that gives the agent a persistent **R** session, as `language: "r"` of the `eval` tool, for statistical analysis, modelling and plotting.

omp has no extension point for new eval languages, so the plugin shadows the built-in `eval` tool: `eval` gains `language: "r"` (see [below](#eval-with-language-r)). Only when eval cannot be shadowed does it register a separate `r` tool instead, never both, so the prompt carries one description of R.

## Install

```sh
omp plugin install github:I0-oX/omp-plugin-r
```

or, from a local checkout:

```sh
omp plugin link /path/to/omp-plugin-r
```

Requires `R` on `PATH` (or set `R_BIN` to an executable R binary). If R is not found the plugin registers nothing, so no dead tool is advertised.

With the standalone `r` tool (fallback only), the tool is discoverable rather than always loaded: with omp's `tools.xdev` on the model reaches it as `xd://r`, so its description only costs prompt space when R is used. Under the `eval` shadow the R notes are a short section of `eval`'s description instead.

### Configuration

| Environment variable | Default | Meaning |
| --- | --- | --- |
| `R_BIN` | `R` on `PATH` | R binary to run. |
| `OMP_R_IDLE_MINUTES` | `30` | Stop the R process after this many minutes without calls; `0` = never. |

## `eval` with `language: "r"`

`eval({ language: "r", code, title?, timeout?, reset? })` runs the cell in a persistent R session (state, plots, files-written notes and interrupt handling as described under [The R tool](#the-r-tool)). `py`/`js` cells are forwarded to omp's native `eval` through `ctx.invokeTool` (only the native fields `language`, `code`, `title`, `timeout`, `reset`), so retained kernels, preludes (`ratchet`, `browser`, `archive`, ...), streaming and auto-background keep working.

How it hooks in:

- On `session_start` the plugin reads the native `eval` description and `language` schema from `pi.getAllTools()` (it throws during extension loading), then re-registers `eval` with the language list extended by `"r"` and a short R section appended to the description. Only runtimes the native tool advertises are offered.
- Fallback: if eval is disabled, already shadowed by another extension, its native schema cannot be parsed, shadowing throws, or `@oh-my-pi/pi-tui/tools/eval` cannot be imported (these failures raise a warning when there is a UI), nothing is shadowed and the plugin registers the standalone `r` tool (same session, same behaviour; reached as `xd://r` when `tools.xdev` is on).
- py/js cells render with omp's own eval renderer (`evalToolRenderer`), R cells with `src/render.ts`. The shadow sets `concurrency: "exclusive"` and `mergeCallAndResult` as the native tool does.
- Known differences while shadowed: the tool description is a snapshot taken at `session_start`, so a prelude enabled mid-session reaches the model through omp's own notice but not through this text; `xd://eval/<topic>` docs (`judge`, `helpers`, prelude docs) cannot be read because omp looks them up on the registered tool; `hasBuiltInTool("eval")` is false, so omp's built-in renderer is not used and the pending/running spinner animation of py/js cells and the native-terminal (TSP) card are lost; `title` is shown for py/js cells only.

## The R tool

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
- **TUI rendering** matches omp's `eval` cells: a framed cell with status icon, `R` title and duration, the highlighted code, and an `Output` section. Collapsed output shows its last 10 rows (`ctrl+o` expands), errors are drawn in the error colour, and notes (`[files written: …]`, interrupt/error markers) sit under the frame. omp does not export its frame helpers to extensions, so `src/render.ts` redraws the frame from the `Theme`, `@oh-my-pi/pi-tui` and `pi.pi`; it also borrows omp's private framed-block marker from the built-in `ask` renderer so the cell is not padded or tinted. Extension tools get no spinner animation from omp, so the running icon is static.

### Cancellation and timeouts

On timeout or cancel R is interrupted with SIGINT, like Ctrl-C. Interrupts are checked by `Sys.sleep`, interpreted loops and most R code, so the cell stops at once: the call returns what was produced and the session keeps its objects. Code that does not respond within 2 s (long compiled routines, code that swallows interrupts) is killed; its objects are lost and the next call says so.

### Limits

- R's stdin is the tool's control channel. Code that reads stdin (`scan()`, `readLines("stdin")`) blocks until the timeout. `readline()` is harmless.
- Code that swallows interrupts (`tryCatch(..., interrupt = )`) or loops forever makes a timeout kill R and lose every object. The tool description tells the model to avoid it, save costly objects with `saveRDS()` first, and set a `timeout` longer than the expected run.
- Output is bounded to roughly the first 16k and last 32k characters; the middle is elided with a note.
- The tool has `approval: "exec"`: R can run arbitrary code (`system()`), so it is gated like `bash`.

## How it works

Each cell is written to a temp file and the R process, started once with `R --vanilla --no-echo --no-save --no-restore`, is told to `source()` it with `print.eval = TRUE`. R then prints an end marker `<<OMP-END <token> <status>>>` carrying a random per-run token; the host streams output until it sees that exact token, so user output (or an echoed command) that merely looks like a marker is never mistaken for the end of a cell. Paths and the working directory travel in a control file rather than inside R source, so unusual directory names cannot break quoting.

## Development

```sh
bun test
```

`test/session.test.ts` exercises the protocol against a fake `sh` engine; `test/changed-files.test.ts` covers the written-files scan; `test/r.test.ts` runs against real R and is skipped when R is absent.

## Not included

Stata is not supported yet. The session layer (`src/session.ts`) is engine-agnostic, so another stdin-driven interpreter would be an `Engine` definition plus a tool registration.
