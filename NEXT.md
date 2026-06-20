# NEXT

Loose, forward-looking candidates only — the rough shape of phases not yet
written. Not a commitment; promote an item into `roadmap.md` + `phases/` when
it is actually next. **Delete an item the moment it ships** — history lives in
the roadmap, phase files, and blog, not here. If a cut idea was really needed it
will resurface on its own.

## Current frontier (phase 228)

`kodr check` is a complete standalone diagnostic — `--json`, `--strict`,
`--changed`, `--watch`, `--deep`, `--ci`, `--fix`, and a path argument — over
eight cross-reference sensors (canonical `SENSOR_NAMES` / `SENSOR_SEVERITY`
registry). `kodr hook install/status/uninstall` gate commits and pushes on it,
with `.kodr/config.json` `hooks`/`sensors` blocks for per-project tuning.
Per-phase detail for this surface and everything before it lives in
`roadmap.md` and `blog/` — not here.

The live work is the **staged execution pipeline** (`runStagedPrompt`) and
the `lang:node` builtin skill. Phases 213–228 chipped at both for local
thinking models (qwen3.6): pending-write `run_command` guards, W3 draft
fallback, `SafeWriteError` steering with `clearFiles`, raised `maxStageWrites`
(8) with unique-path dedup, inter-stage `npm install`, the phase-224
`safeWriteSteered` flag, the phase-225 zero-applied-write auto-advance, the
phase-226 duplicate-block guard in `preparePatches` (`reason: 'duplicate_block'`),
the phase-227 `lang:node` pitfall trio (node:sqlite `DatabaseSync` import
name, check-status-before-parse, module-scope side effects), and the phase-228
profile-aware heal per-turn timeout (wireNoStream profiles now get the full
main-loop budget instead of the D2 240s cap).

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

### Heal-turn timeouts on wireNoStream thinking models
Heal turns on the qwen3.6 (wireNoStream) profile hit the per-turn timeout in
~1/3 of cases and lose the entire turn (0 captured chars). **The earlier
"context overflow / accumulated turn-log" framing was wrong** — re-derived from
36 heal-turn `turn-meta.json` artifacts (2026-06-15..20): outcome is
**uncorrelated with prompt size**. A 4,730-char heal prompt timed out at 240s
with 0 chars while a 4,977-char one returned 1,190 chars in 14s; an 18,127-char
prompt returned 7,289 chars in 116s while an 18,253-char one timed out. Same-size
prompts both succeed and fail. The heal prompt is also built **fresh**
(`renderLoopRepairPrompt` = tests.json + repair-context files), so it never
carries the staged turn-log; the "378k cumulative tokens" figure was the whole
run, not the heal request. Real mechanism: (1) the heal per-turn cap is
`min(timeoutMs, 240_000)` = 240s while main turns get the full 600s, yet the
same slow wireNoStream thinking model is generating (successes ran up to 116s, so
the tail past 240s is plausibly just-slow, not hung); (2) wireNoStream returns
nothing until the full response lands, so any timeout is a total loss (0 captured
chars) and we cannot tell slow from hung (no first-token signal). Design
directions, in order of confidence: **(a) shipped in phase 228** — make the heal
per-turn timeout profile-aware by giving wireNoStream profiles a budget aligned
with their main-loop per-turn budget (`min(timeoutMs, 600_000)`) instead of the
tight 240s default cap; (b) trim the heal prompt's verbatim file embeds (real
waste — one prompt embedded a 228-line test file — but proven NOT to fix the
timeout, so ship it as a quality fix, not the cure); (c) stream heal turns even
for wireNoStream so partial output survives a timeout and first-token detection
can distinguish slow from hung (highest value, highest risk — wireNoStream exists
because streaming tool-calls was unreliable for this model; needs live
validation). Efficacy of (a) on the >240s tail is unmeasured — the phase-228
dogfood step is the measurement. Evidence: heal `turn-meta.json` across
phase-201/204/216/219/225/226 and final-audit runs in `~/src/kodr-testing`.
