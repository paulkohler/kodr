# NEXT

Loose, forward-looking candidates only — the rough shape of phases not yet
written. Not a commitment; promote an item into `roadmap.md` + `phases/` when
it is actually next. **Delete an item the moment it ships** — history lives in
the roadmap, phase files, and blog, not here. If a cut idea was really needed it
will resurface on its own.

## Current frontier (phase 235)

`kodr check` is a complete standalone diagnostic — `--json`, `--strict`,
`--changed`, `--watch`, `--deep`, `--ci`, `--fix`, and a path argument — over
eight cross-reference sensors (canonical `SENSOR_NAMES` / `SENSOR_SEVERITY`
registry). `kodr hook install/status/uninstall` gate commits and pushes on it,
with `.kodr/config.json` `hooks`/`sensors` blocks for per-project tuning.
Per-phase detail for this surface and everything before it lives in
`roadmap.md` and `blog/` — not here.

The live work is the **staged execution pipeline** (`runStagedPrompt`) and
the `lang:node` builtin skill. Phases 213–235 chipped at both for local
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
fast-fail caught by phase-231), and the phase-235 heal draft carryover fix
(`ProposalDraft.clear()` at the top of each `repairTurn` callback clears the shared
registry draft before the model call so stale main-run writes are never re-emitted
as no-op proposals, restoring phase-231's `reasoning_runaway` classification accuracy
— previously defeated whenever the main run had written files).

## Candidates

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

### Completion cap tightness on thinking models (follow-up to phase 234)

**Detection (phase 231) and honored cap (phase 234) both shipped.** The `max_tokens`
cap at `completionReserve` (4096 for qwen3.6) converts reasoning runaway from a
200–330s grind into a sub-second `finish_reason:length` fast-fail, caught immediately
by the phase-231 `isReasoningRunaway` predicate.

**Corrected understanding (from the 2026-06-20 probe):** `max_thinking_tokens`,
`reasoning_effort`, and nested `reasoning.max_tokens` are all IGNORED by qwen3.6 on
LM Studio. Only `max_tokens` / `max_completion_tokens` are honored, and they cap the
SUM (reasoning + answer combined). The cap does NOT reserve answer room — a runaway
can still spend the entire cap on reasoning and return `finish_reason:length` with
zero answer tokens. The benefit is fast-fail speed, not answer preservation.

**Residual open question:** whether a `completionReserve:4096` cap is too tight for
large multi-file heal answers on thinking models. The 2026-06-20 probe baseline used
only 1601 tokens total (1425 reasoning + 176 answer), well under 4096. But a
legitimate large-file heal answer that needs >4096 reasoning+answer tokens would hit
`finish_reason:length` and be misread as runaway by the phase-231 predicate. Watch
for false-positive `reasoning_runaway` stop reasons in ambitious dogfood — if
observed, raise `completionReserve` for the affected profile or add a token-count
heuristic to the predicate.

**Phase-231 dogfood note:** the runaway is probabilistic in the agentic tool-call
heal channel — the detection fires on `finishReasons[-1] === 'length'` but on
live runs the model sometimes emits tool calls each sub-turn and exhausts the
sub-turn budget instead (`turn_budget_exhausted`). Ambitious dogfood is the reliable
trigger for genuine runaways.

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

