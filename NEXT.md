# NEXT

Loose, forward-looking candidates only — the rough shape of phases not yet
written. Not a commitment; promote an item into `roadmap.md` + `phases/` when
it is actually next. **Delete an item the moment it ships** — history lives in
the roadmap, phase files, and blog, not here. If a cut idea was really needed it
will resurface on its own.

## Current frontier (phase 240)

`kodr check` is a complete standalone diagnostic. The staged execution pipeline
(`runStagedPrompt`) and `lang:node` builtin skill have been hardened through
phases 213–240 for local thinking models (qwen3.6): reasoning-runaway fast-fail
and heal cap (231/234/236), staged implement-turn runaway detect-and-retry (240),
staged draft carryover fixes (235/237), W4 parity merge (233), ESM cache-bust
pitfall (238), and the phase-239 hardening audit (network/model boundary
hardening, CLI/pipeline seam extraction, skill loading corrections). The `--skill`
flag now falls through to the builtin registry when workspace discovery finds
nothing.

## Candidates

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

### Re-decide the @kodr/repomap publish hold
Parked by decision (2026-06-12: no publish until more dogfooding); the
precondition is now met, so this needs a human call and won't resurface on its
own.

### llms.txt doc-lookup pattern for skills
BLOCKED on exposing a fetch tool to the model-callable registry (network-egress
security boundary: SSRF / private-IP / size guards, permission-gated, real
integration run required per AGENTS.md). Do not add `## Documentation` sections
to builtin skills until the fetch prerequisite lands.

### Smoke-as-verification in the heal loop
Phase 184 wired a smoke-driven second heal pass, but in-loop verification still
uses `options.testCommand`. Full smoke-as-verification requires pluggable
verification backends (callers pass a `verify` function). Significant architecture
change — not plannable without an interface sketch.

### Completion cap tightness — heal-specific residual (watch-for-it)
`completionReserve:4096` may be too tight for a large multi-file heal answer.
The 2026-06-20 probe used only 1601 tokens (well under 4096), so no false
positive yet. If observed: raise `completionReserve` (e.g. 8192) or add a
token-count heuristic to `isReasoningRunaway` (e.g. treat length+zero-answer as
runaway only if completionTokens is near the cap).
