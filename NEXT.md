# NEXT

Loose, forward-looking candidates only — the rough shape of phases not yet
written. Not a commitment; promote an item into `roadmap.md` + `phases/` when
it is actually next. **Delete an item the moment it ships** — history lives in
the roadmap, phase files, and blog, not here. If a cut idea was really needed it
will resurface on its own.

## Current frontier (phase 233)

`kodr check` is a complete standalone diagnostic — `--json`, `--strict`,
`--changed`, `--watch`, `--deep`, `--ci`, `--fix`, and a path argument — over
eight cross-reference sensors (canonical `SENSOR_NAMES` / `SENSOR_SEVERITY`
registry). `kodr hook install/status/uninstall` gate commits and pushes on it,
with `.kodr/config.json` `hooks`/`sensors` blocks for per-project tuning.
Per-phase detail for this surface and everything before it lives in
`roadmap.md` and `blog/` — not here.

The live work is the **staged execution pipeline** (`runStagedPrompt`) and
the `lang:node` builtin skill. Phases 213–232 chipped at both for local
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
stop reason), and the phase-232 synthetic staged-completion user turn (when the
staged repeat-escalation sentinel fires, a `user`-role message is injected after
all tool results, offering the dual-exit: write the next file or return
`STAGED_DONE`; tools remain available; fire-once per `completeWithToolCalls` call),
and the phase-233 W4-parity merge in `runStagedPrompt` (a `write_file` draft
captured in `proposalDraft` is now merged into a valid STAGED_DONE envelope before
the empty-paths check, so pending draft writes are applied and the stage terminates
done in one turn — fixing the silent-data-loss bug discovered in `final-audit-2`
where `server.test.mjs` was captured in the draft but discarded when the STAGED_DONE
envelope had `files:[]`).

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

### Bound the reasoning budget on heal turns (follow-up to phase 231)

**Detection and fast-fail shipped in phase 231.** When qwen3.6 (wireNoStream)
exhausts its 32K context window on reasoning and returns `finish_reason: "length"`
with zero answer tokens, the heal loop now breaks immediately with
`stopReason: 'reasoning_runaway'` and an accurate diagnostic. The open problem is
the mitigation: making the model leave room for an answer.

**The lever:** kodr sends `max_thinking_tokens: 4096` in heal requests but LM
Studio / qwen3.6 produced 21,693 reasoning tokens in the verified failure artifact
(`final-audit/blog-platform`, 2026-06-20) — so the cap is being ignored. Before
building any mitigation, determine which parameter LM Studio actually honors for
qwen3.6: `max_thinking_tokens`? `max_tokens`? `max_completion_tokens`?
`reasoning_effort`? This needs empirical testing against the running model — the
request builder is a pure function and deterministically testable once the honored
wire param is identified.

**Once the param is known:** reserve answer room by setting that param to
`contextWindow - promptTokens - answerBudget` on heal requests, so the model
cannot consume the entire window with reasoning. Secondary options (trimming
verbatim file embeds in the heal prompt; streaming heal turns so a partial answer
survives) remain open but are less impactful than the token-cap fix.

**Phase-231 dogfood (2026-06-20, `phase-231/heal-runaway-3`) — two findings:**
(1) The runaway is **probabilistic in the agentic tool-call heal channel**: the
detection fires on `finishReasons[-1] === 'length'` (the reference run reasoned to
the window limit on sub-turn 1 before emitting any tool call — `turns:1`,
`finish_length`, 0 content), but on the dogfood the model instead emitted tool
calls each sub-turn and exhausted the 8-sub-turn budget (`turn_budget_exhausted`,
NOT a runaway). So phase-231's predicate is correctly scoped, but live runaways
recur only when the model reasons-to-length on sub-turn 1 — the limit-pushing
ambitious dogfood is the reliable trigger.

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

