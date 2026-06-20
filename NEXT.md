# NEXT

Loose, forward-looking candidates only — the rough shape of phases not yet
written. Not a commitment; promote an item into `roadmap.md` + `phases/` when
it is actually next. **Delete an item the moment it ships** — history lives in
the roadmap, phase files, and blog, not here. If a cut idea was really needed it
will resurface on its own.

## Current frontier (phase 226)

`kodr check` is a complete standalone diagnostic — `--json`, `--strict`,
`--changed`, `--watch`, `--deep`, `--ci`, `--fix`, and a path argument — over
eight cross-reference sensors (canonical `SENSOR_NAMES` / `SENSOR_SEVERITY`
registry). `kodr hook install/status/uninstall` gate commits and pushes on it,
with `.kodr/config.json` `hooks`/`sensors` blocks for per-project tuning.
Per-phase detail for this surface and everything before it lives in
`roadmap.md` and `blog/` — not here.

The live work is the **staged execution pipeline** (`runStagedPrompt`). Phases
213–226 chipped at it for local thinking models (qwen3.6): pending-write
`run_command` guards, W3 draft fallback, `SafeWriteError` steering with
`clearFiles`, raised `maxStageWrites` (8) with unique-path dedup, inter-stage
`npm install`, `lang:node` skill pitfalls, the phase-224 `safeWriteSteered` flag,
the phase-225 zero-applied-write auto-advance, and the phase-226 duplicate-block
guard in `preparePatches` (`reason: 'duplicate_block'`) that prevents a patch
whose `replace` is an existing multi-line block from writing a duplicate to disk.

## Candidates

### Staged completion: synthetic user turn instead of embedded tool hint
Phase-223 dogfooding: embedding STAGED_DONE JSON in a tool-error message does not
reliably break the model's tool-calling loop. The model needs the completion
instruction delivered as a clean user turn (not buried in error JSON). When the
staged sentinel escalates (count >= ESCALATION_THRESHOLD) and inStagedPipeline
is true, inject a synthetic user message after the tool result — e.g., appended
to the `messages` array before the next iteration — that says:
"All target files are written. Stop calling tools. Return only:
`{\"status\":\"OK\",\"files\":[],\"messages\":[{\"level\":\"info\",\"content\":\"STAGED_DONE\"}]}`"
This is architecturally different from Phase 223's tool-error approach: it sends a
user-role message that the model must respond to, rather than a tool result it may
ignore. Needs careful placement in completeWithToolCalls so it fires after the tool
result is appended but before the next request.

### lang:node skill pitfalls from 224–226 dogfooding
Three live staged runs (Express + node:sqlite notes API, qwen3.6) produced
recurring, addressable code-quality bugs the `lang:node` builtin skill does not
yet name: (a) `import { Database } from 'node:sqlite'` — the export is
`DatabaseSync`, a parse/runtime failure; (b) integration tests that `JSON.parse`
a response without checking status/content-type, so an HTML 404 page surfaces as
`SyntaxError: Unexpected token '<'`; (c) module-scope side effects in server.mjs
(`createDatabase()` / `createServer()` running at import, not behind the
`import.meta.url` guard). Add named pitfall entries (correct vs wrong) like the
phase-218/223 SQLite entries. Cheap, deterministic to add, and directly improves
example quality — the project's measurement goal. Evidence in
`process/failures.jsonl` (224-dogfood, 225-dogfood, 226-dogfood).

### run_command pending-write guard: staged-mode wording
Phase 220 agent noted: the run_command guard hint "Return file changes in the
final JSON proposal" has the same staged/envelope ambiguity as the sentinel
wording fixed in Phase 220. When applyMode===proposal and inStagedPipeline===true,
the guard should say: "Apply file changes via write_file tool calls. Do not run
commands until all files are written." Mirror the Phase-220 pattern.

### Re-decide the @kodr/repomap publish hold
Parked by decision (2026-06-12: no publish until more dogfooding); the
precondition is now met, so this needs a human call and won't resurface on its
own.

### llms.txt doc-lookup pattern for skills
When a skill covers a library or API with online docs, encode a `llms.txt`
index URL as the fallback documentation source. Pattern observed in
google/gemma-skills: if an MCP search tool is available use it; else fetch
`https://<domain>/llms.txt` to discover available pages, then fetch specific
pages as needed. A general direction: add a `## Documentation` section to any
builtin skill that has a known `llms.txt` (Express, SQLite, busboy, etc.) so
the model has a live path to current API docs when its training data is stale.
Note: kodr has no external skill registry yet — this applies only to builtin
skills as they are added.

### Smoke-as-verification in the heal loop
Phase 184 wired a smoke-driven second heal pass, but the in-loop verification
still uses `options.testCommand`. When no testCommand is set, smoke failures
can't drive repairs. Full smoke-as-verification requires pluggable verification
backends: callers pass a `verify` function instead of a `testCommand` string.
Significant architecture change — not yet plannable without an interface sketch.

### Heal-loop context overflow on thinking models
Three rounds of large thinking-model responses exhaust the 32 K context budget
before healing completes, producing an empty final output. This is the
highest-impact systemic issue from phase 204 (`--no-heal` is the current
workaround). The 225- and final-audit dogfoods re-confirmed it bites now that
staged runs reliably reach verification: a repair turn timed out at 240s with
**0 completion chars** (`healStopReason: timeout`) — the model never emitted a
token before the cap. The final-audit run pinned the cause: the heal prompt was
25.5k chars after ~41 main turns / 378k cumulative prompt tokens, so the **staged
run's accumulated turn-log tail** is what pushes the heal request past what the
model can service. Design direction: before a heal request on a staged run, drop
or compress the accumulated prior staged turns (not just cap the heal response
size); optionally cap heal turns when `wireNoStream`. Now the strongest systemic
candidate, but still needs a design sketch before it becomes a phase.
