# NEXT

Loose, forward-looking candidates only — the rough shape of phases not yet
written. Not a commitment; promote an item into `roadmap.md` + `phases/` when
it is actually next. **Delete an item the moment it ships** — history lives in
the roadmap, phase files, and blog, not here. If a cut idea was really needed it
will resurface on its own.

## Current frontier (phase 224)

`kodr check` is a complete standalone diagnostic — `--json`, `--strict`,
`--changed`, `--watch`, `--deep`, `--ci`, `--fix`, and a path argument — over
eight cross-reference sensors (canonical `SENSOR_NAMES` / `SENSOR_SEVERITY`
registry). `kodr hook install/status/uninstall` gate commits and pushes on it,
with `.kodr/config.json` `hooks`/`sensors` blocks for per-project tuning.
Per-phase detail for this surface and everything before it lives in
`roadmap.md` and `blog/` — not here.

The live work is the **staged execution pipeline** (`runStagedPrompt`). Phases
213–224 chipped at it for local thinking models (qwen3.6): pending-write
`run_command` guards, W3 draft fallback, `SafeWriteError` steering with
`clearFiles`, raised `maxStageWrites` (8) with unique-path dedup, inter-stage
`npm install`, `lang:node` skill pitfalls, and the phase-224 `safeWriteSteered`
flag that terminates the loop after a `files[]`-vs-existing steer. Phase-224
dogfooding showed the budget-exhaustion problem is only *partly* closed: a
sibling stall — consecutive stages that apply *zero* writes (no-op `edit_file`
patches on already-correct files, so no `SafeWriteError` and no empty proposal)
— still grinds to the stage budget. See the top candidate below.

## Candidates

### Stage auto-advance on zero *applied* writes (no-op patch stall)
Phase-224 dogfooding (Express+SQLite notes API, qwen3.6): the model wrote all
four files in stage 1, fixed two real bugs with `edit_file` patches in stage 2,
then in stages 3–7 re-read the files, judged them correct, and looped on rejected
`run_command` calls. Each of those stages recorded `applied:true` but
`writeCount:0` (no-op patches / no matching edits). Phase-224's arm only fires on
`safeWriteSteered` (a `files[]`-vs-existing `SafeWriteError`), and the
`paths.length===0` no-progress branch never fired because the proposal still
*claimed* paths. So the loop ground to the 7-stage budget — ending `ok:true` only
because the tests happened to pass, with `staged.done:false`.
Fix: key no-progress on *applied* writes (`writeResult.writes.length === 0`), not
on proposed `paths.length`. Increment `noProgressTurns` on a zero-applied-write
stage, and after N consecutive such stages (with real writes applied earlier in
the run) auto-complete — the same mechanical break as phase 224, generalized to
the no-op-patch pattern. Secondary: the stage record's `paths` field shows
*proposed* paths on zero-write stages, which is misleading in forensics — record
applied paths, or add a separate `appliedPaths`/`writeCount`-only view. This is
the direct continuation of phase 224 and the strongest next step.

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

### edit_file patch collisions in multi-write stages
Phase-223 run-3 forensics: `src/server.mjs` ended with a duplicate
`export let server;` and every test failed with "Identifier 'server' has already
been declared." `ProposalDraft._files` dedupes `write_file` by path
(last-write-wins), but `_patches` is append-only, so two `edit_file` calls that
re-add the same construct both apply. Fix direction: before applying a patch in
`prepareChanges`/`safe-writes`, skip it when its search string is no longer
present in the current (post-prior-patch) content — and first confirm whether the
existing "search string not found" guard silently ignores non-matching patches or
errors. Mostly relevant once a stage emits several `edit_file` calls for one file.

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
workaround). Fix options: cap heal turns when `wireNoStream`, drop prior heal
turns from context before each retry, or compress the turn log. Needs design
before it becomes a phase.
