# NEXT

Loose, forward-looking candidates only — the rough shape of phases not yet
written. Not a commitment; promote an item into `roadmap.md` + `phases/` when
it is actually next. **Delete an item the moment it ships** — history lives in
the roadmap, phase files, and blog, not here. If a cut idea was really needed it
will resurface on its own.

## Current frontier (phase 238)

`kodr check` is a complete standalone diagnostic — `--json`, `--strict`,
`--changed`, `--watch`, `--deep`, `--ci`, `--fix`, and a path argument — over
eight cross-reference sensors (canonical `SENSOR_NAMES` / `SENSOR_SEVERITY`
registry). `kodr hook install/status/uninstall` gate commits and pushes on it,
with `.kodr/config.json` `hooks`/`sensors` blocks for per-project tuning.
Per-phase detail for this surface and everything before it lives in
`roadmap.md` and `blog/` — not here.

The live work is the **staged execution pipeline** (`runStagedPrompt`) and
the `lang:node` builtin skill. Phases 213–237 chipped at both for local
thinking models (qwen3.6): pending-write `run_command` guards, W3 draft
fallback, `SafeWriteError` steering with `clearFiles`, raised `maxStageWrites`
(8) with unique-path dedup, inter-stage `npm install`, the phase-224
`safeWriteSteered` flag, the phase-225 zero-applied-write auto-advance, the
phase-226 duplicate-block guard in `preparePatches` (`reason: 'duplicate_block'`),
the phase-227 `lang:node` pitfall trio (node:sqlite `DatabaseSync` import
name, check-status-before-parse, module-scope side effects), the phase-228
profile-aware heal per-turn timeout (wireNoStream profiles now get the full
main-loop budget instead of the D2 240s cap), the phase-229 staged-aware
`run_command` / turn-exhaustion guard wording (three sites made staged-aware so
the model no longer receives envelope-only or factually false instructions in a
staged run), the phase-230 per-test timeout for pm-delegated `node --test`
verification (scoped rewrite of `npm test` / `pnpm test` / `yarn test` to
`node --test` when `scripts.test` is a bare `node --test`, so the existing
`--test-timeout` injection applies and one hung generated test fails fast), the
phase-231 reasoning-runaway fast-fail in the heal loop (detect `finish_reason:
length` with zero answer tokens, break immediately, accurate `reasoning_runaway`
stop reason), the phase-232 synthetic staged-completion user turn (when the
staged repeat-escalation sentinel fires, a `user`-role message is injected after
all tool results, offering the dual-exit: write the next file or return
`STAGED_DONE`; tools remain available; fire-once per `completeWithToolCalls` call),
the phase-233 W4-parity merge in `runStagedPrompt` (a `write_file` draft
captured in `proposalDraft` is now merged into a valid STAGED_DONE envelope before
the empty-paths check, so pending draft writes are applied and the stage terminates
done in one turn — fixing the silent-data-loss bug discovered in `final-audit-2`
where `server.test.mjs` was captured in the draft but discarded when the STAGED_DONE
envelope had `files:[]`), the phase-234 honored `max_tokens` completion cap
(`completionReserve` value sent as `max_tokens` in every model request, converting
reasoning-runaway from a 200–330s grind to a sub-second `finish_reason:length`
fast-fail caught by phase-231), the phase-235 heal draft carryover fix
(`ProposalDraft.clear()` at the top of each `repairTurn` callback clears the shared
registry draft before the model call so stale main-run writes are never re-emitted
as no-op proposals, restoring phase-231's `reasoning_runaway` classification accuracy
— previously defeated whenever the main run had written files), the phase-236
heal-only cap scope (the honored `max_tokens:completionReserve` cap is now gated on
`completionCapMode:'heal'` in the options bag; the main loop and staged path carry no
marker and revert to the known-good pre-234 uncapped wire shape — a ground-truth probe
showed the 4096 cap starved a realistic two-file generation task to 0 answer chars),
the phase-237 staged `clearFiles` patch leak fix (`ProposalDraft.clearPatches(paths)`
added symmetric to `clearFiles`, called alongside `clearFiles(appliedPaths)` at
`run-pipeline.mjs:2195` — closing the staged half of the phase-235 draft-carryover
asymmetry: an applied `edit_file` patch no longer leaks into every subsequent staged
stage via `proposalPaths` and `mergeProposalWithDraft`), and the phase-238
`lang:node` test-isolation guidance. Phase 239 corrected the mechanism: Node
caches ESM by URL, so different queries create distinct instances; the observed
`Date.now()` pattern was unreliable because timestamps can repeat, and unique
imports retain module instances. The durable advice remains to export a factory
and create fresh state in `beforeEach`.

## Candidates

### Reasoning-then-silence in staged implement turns (completion cap gap)
Phase 231 detected reasoning-runaway fast-fail in heal turns; phases 234/236
scoped the completion cap to heal-only. The **staged implement turns are still
uncapped**. Phase-238-audit (rest-api-sqlite-2) observed exactly the same
failure mode in an implement turn: `finish_reason=length`, `content_len=0`,
23k completion tokens consumed on qwen3.6 extended thinking, 0 tool_calls,
`ProposalMissingError` aborted the stage. Turn 11, prompt=9709, in a 32768
context — the model had 23k token budget and spent every one on CoT.
Fix direction: apply the same `completionCapMode` gate to staged implement
turns via a `completionCapMode: 'staged'` marker, or detect
`finish_reason=length` + `content_len=0` in the staged loop and emit a
`StagedReasoningSilenceError` with auto-retry at lower `max_tokens`. A new
`isReasoningRunaway` call in the staged turn handler (analogous to the heal
turn handler) could reuse the existing predicate. Probe first: confirm that a
lower `max_tokens` (e.g. `completionReserve:4096`) on staged implement turns
does not starve legitimate large file generation — the probe for phase 236
showed the issue on generate turns, so calibrate carefully.
Evidence: `phase-238-audit/rest-api-sqlite-2/.kodr/runs/2026-06-20T22-03-43.228Z/`
conversation.json turn 11, summary.json staged.stages[1].

### `--skill` flag does not resolve builtin skills (workspace-only discovery)
Surfaced in phase-238 dogfood: `kodr run --skill lang:node` from a test workspace
returns "No SKILL.md matched: lang:node" because `--skill` searches for SKILL.md
files in the workspace directory tree, not the builtin-skills registry. Builtin
skills auto-inject correctly via `detectNodeEsm()` (fires on `.mjs` in the prompt)
and are confirmed by `languageGuidance.source: "builtin"` in summary.json — but a
user who tries to force a builtin via `--skill` gets a confusing error. Fix
direction: when `--skill <id>` is passed and workspace discovery yields nothing,
fall through to the builtin registry before erroring. Low-risk additive; the
auto-detect path stays unchanged.

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
skills as they are added. **Precondition (verified 2026-06-20):** the
model-callable builtin registry does NOT expose any fetch tool — it registers
only `list_files`, `read_file`, `inspect_symbols`, `find_references`,
`read_skill_resource`, `run_skill_command`, `run_command`, `write_file`,
`edit_file`. (`fetch_url` exists in `src/tools.mjs` but is NOT registered for the
model.) So a `## Documentation` llms.txt URL would be dead text the model cannot
act on. This candidate is BLOCKED on first exposing a fetch tool to the
model-callable registry — itself a network-egress security boundary (SSRF /
private-IP / size guards, permission-gated, real integration run per AGENTS.md).
Do not ship the llms.txt docs until that prerequisite lands.

### Smoke-as-verification in the heal loop
Phase 184 wired a smoke-driven second heal pass, but the in-loop verification
still uses `options.testCommand`. When no testCommand is set, smoke failures
can't drive repairs. Full smoke-as-verification requires pluggable verification
backends: callers pass a `verify` function instead of a `testCommand` string.
Significant architecture change — not yet plannable without an interface sketch.

### Completion cap tightness on thinking models — heal-specific residual (follow-up to phases 234/236)

**Detection (phase 231), honored cap (phase 234), and main-loop un-starvation
(phase 236) have all shipped.** The `max_tokens:completionReserve` wire cap is
now HEAL-ONLY (gated on `completionCapMode:'heal'`). The main loop and staged path
are uncapped — the known-good pre-234 behavior. The main-loop truncation concern
is fully resolved by phase 236.

**Residual heal-specific open question:** whether `completionReserve:4096` is too
tight for a large multi-file heal answer. The 2026-06-20 probe used only 1601
tokens total on a small task (1425 reasoning + 176 answer), well under 4096. A
legitimate heal answer that genuinely needs >4096 reasoning+answer tokens would
hit `finish_reason:length` and be misread as runaway by the phase-231 predicate —
a false-positive `reasoning_runaway` stop reason. Watch for this in ambitious
dogfood. If observed: raise `completionReserve` for the profile (e.g. 8192), or
add a token-count heuristic to the predicate (e.g. treat length+zero-answer as
runaway only if completionTokens is near the cap), or adopt design (C) from the
phase-236 plan (tight heal cap + generous main-loop cap) — but the threshold for
design (C) is observing a genuine main-loop runaway that timeout+budget cannot
contain fast enough, which has not yet occurred.

### Heal request HTTP-400 "Context size exceeded" after a heavy main loop (diagnose-first)
A heal/repair request returns `HTTP 400 "Context size has been exceeded"`
(`stopReason: 'repair_error'`) after a long delay (~200–240s) following a
context-heavy staged run — observed in TWO dogfoods (`phase-231/heal-runaway-3`
turn-3, and `final-audit-2/content-api` turn-1). **The cause is NOT kodr
over-sending the repair prompt.** Re-derived from `final-audit-2` turn-1: the
repair-context was EMPTY (`repair-context.json` `files:[]`), the prompt was small
(~14k chars), there was NO `raw-response.json` (it 400'd on the FIRST request,
zero sub-turns), yet it still 400'd after 207s. A 14k prompt cannot exceed a 32k
window — so the lever is the **LM Studio session/KV-cache state carrying over from
the heavy main loop** (77k cumulative prompt tokens), not the heal prompt size.
(This SUPERSEDES the earlier "tool-call sub-turn accumulation" framing — that did
not hold for the empty-context turn-1 case.) Fix direction: detect the
`repair_error` HTTP-400 and retry the heal with a fresh session / cache reset, or
ensure the heal request starts a clean server session rather than appending to the
main loop's context. Diagnose first: confirm whether kodr reuses a session id /
KV cache between the main loop and the heal request, and whether a reset clears
the 400.

Evidence: `final-audit/blog-platform/.kodr/runs/2026-06-20T04-45-40.838Z/repairs/`
`turn-1/raw-response.json` + `turn-meta.json`; `phase-231/heal-runaway-3` and
`final-audit-2/content-api` run artifacts. See also phase-231 + `final-audit-2`
`failures.jsonl` entries and `blog/231-heal-reasoning-runaway-fast-fail.md`.
