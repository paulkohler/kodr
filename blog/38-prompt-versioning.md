# Phase 38: Prompt Versioning

Phase 38 makes prompt iteration traceable. Before this phase there was no
connection between a run's `summary.json` and the prompt text that produced it.
Now every run carries a `promptId`, and `kodr prompt-history <id>` lists all
runs that share one.

## What changed

### `src/prompt-id.mjs`

Two pure exports:

**`derivePromptId(text)`** — SHA-256 of the prompt content, first 8 hex chars.
Compact, deterministic, and collision-resistant enough for grouping runs. The
same prompt always produces the same id; a whitespace edit produces a different
one.

**`promptIdFromFilename(filePath)`** — takes the basename without extension,
lowercases it, replaces runs of non-alphanumeric characters with a single
hyphen, and trims leading/trailing hyphens. `prompts/todo-cli-v2.md` → 
`todo-cli-v2`. This lets files in the `prompts/` stash link automatically to
the runs they produced.

### `src/run-history.mjs`

**`scanRunHistory(cwd, promptId)`** scans `.kodr/runs/`, reads each
`summary.json`, and returns the subset matching `promptId`. If
`eval-results.json` exists in the same run dir, the `evalScore` is included.
Results are sorted by run dir name (which is an ISO timestamp, so this is
chronological). Dirs without a `summary.json` are silently skipped.

### `src/app.mjs` changes

**`--prompt-id <slug>`** — explicit override stored in `options.promptId`.

**`--prompt-file` auto-linking** — when `--prompt-file` is used and no
`--prompt-id` was given, `promptIdFromFilename` derives the id from the
filename. Existing prompt stash entries are linked to their runs without
touching anything.

**`-p` inline prompts** — fall back to the SHA-256 content hash.

**`summary.json`** gains two new fields: `promptId` and `timestamp`. The
timestamp is the ISO 8601 string at the moment the run completes. Both the
success path in `runPrompt` and the error path in `writeRunFailure` write
these fields.

**`kodr prompt-history <promptId>`** — new command. Calls `scanRunHistory`,
prints one line per matching run (`timestamp  model  [ok|fail]  eval=N.NN`),
and supports `--json` for machine-readable output.

### Resolution priority for `promptId`

```
--prompt-id slug      → use slug directly
--prompt-file path    → promptIdFromFilename(path)
-p "inline prompt"    → derivePromptId(text)
```

## Example session

```sh
# First run with a named prompt file
./kodr run --prompt-file prompts/todo-cli.md
# summary.json: { promptId: "todo-cli", ... }

# Second run with an explicit override
./kodr run -p "Build a todo CLI" --prompt-id todo-cli
# summary.json: { promptId: "todo-cli", ... }

# See all runs for that prompt
./kodr prompt-history todo-cli
# Prompt history: todo-cli
#   2026-05-28T10:12:00.000Z  qwen/qwen3.6-35b-a3b  [ok]
#   2026-05-28T10:18:00.000Z  qwen/qwen3.6-35b-a3b  [ok]
```

```sh
# JSON output
./kodr prompt-history todo-cli --json
# { "promptId": "todo-cli", "runs": [ ... ] }
```

## Test coverage

**`test/prompt-id.test.mjs`** — 11 tests: 8-char hex output, determinism,
collision avoidance, empty string, basename extraction, lowercase, special-char
replacement, hyphen collapsing, leading/trailing hyphen stripping, absolute
paths, nested relative paths.

**`test/run-history.test.mjs`** — 7 tests: missing runs dir, no match, match
found, eval score inclusion, ascending sort, skip dirs without summary.json,
timestamp from summary.

**`test/app.test.mjs`** additions — 8 tests: `parseArgs --prompt-id`, `parseArgs
prompt-history`, throws on missing id, empty history, content-hash promptId in
summary, override promptId in summary, filename-slug promptId in summary,
integration (run then prompt-history finds the run).

Total tests: 226/226 passing.

## Design notes

**8-char hash is the right default size.** Collision probability with 8 hex
chars (2^32 values) is negligible for the number of distinct prompts a single
project ever uses. Shorter would look nicer; longer adds no real value.

**Why two separate modules.** `prompt-id.mjs` has zero async I/O — both
functions are pure and fast. `run-history.mjs` is all async I/O with no hash
logic. Keeping them separate makes them independently testable and prevents
either from pulling unnecessary dependencies.

**`timestamp` in summary.** The run dir name encodes a timestamp, but parsing
an ISO-formatted path is fragile and locale-dependent. Embedding the timestamp
directly in `summary.json` is the canonical form.

**eval score in history.** `scanRunHistory` reads `eval-results.json` if it
exists in the run dir. A `kodr run` normally doesn't produce one, so
`evalScore` is usually `null`. A future workflow that runs eval in the same
dir (e.g., `--eval-suite`) would populate it automatically.
