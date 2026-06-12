# Phase 112 — Measured Structured Output

## Motivation

Phase 111's live validation re-run (gemma-smoke-2) still failed: gemma-4 emits
a literal `<|"|>` pseudo-token where escaped/closing quotes belong inside JSON
strings, corrupting every envelope, and a substantial-content `finish_stop`
with no extractable proposal never engages the repair loop. Investigating how
kodr requests JSON exposed a deeper inconsistency:

- `proposalResponseFormat()` (strict `json_schema`) exists, but
  `shouldOmitResponseFormat` drops it whenever provider is `local` and tools
  are present — so the normal local dogfooding path runs fully unconstrained.
- Phase 109's final-turn forcing removes `tools` from the request, which makes
  the omission rule stop matching: **the strict schema silently reattaches on
  exactly the final turn**. On qwen3.6 that is the configuration phase 110
  proved fatal (empty content, all reasoning). The model experiences a
  different output contract on different turns of one conversation.
- Repair turns send no response_format (phase 110 decision). The E4 nudge
  turn inherits the same final-turn flip.
- Model profiles (phase 69) carry `nativeToolCalls` and `responseEnvelope`
  but no structured-output capability — the blanket provider+tools heuristic
  stands in for what is a per-model fact.

Principles: the envelope contract should be *the same on every turn* of a
conversation, and the constraint mechanism should be a measured per-model
capability, not a provider-level guess. The JSON repair pipeline stays
regardless — constrained decoding reduces entropy but is not available or
healthy on every model/server combination.

## Measurements (run before implementation, 2026-06-12)

A/B replay of the exact saved gemma-smoke-2 request against LM Studio
(`google/gemma-4-26b-a4b`), scored with kodr's own extractor. Script and
content artifacts: `~/src/kodr-testing/phase-112/ab-structured-output/`.

| Variant | tools | response_format | Outcome |
|---|---|---|---|
| A (live run) | yes | none | 5 fenced blocks, 7 `<|"|>` artifacts, no proposal |
| B | no | none | **Clean: 22.6s**, finish `stop`, 6 fenced blocks, 0 artifacts; phase-111 merge yields both files (2,354 completion tokens, 627 reasoning) |
| C | no | json_schema (strict) | **Stall: no response in 300s** (connection dropped; 13× the unconstrained latency and still nothing) |
| D | no | json_object | **Rejected by LM Studio, HTTP 400:** `'response_format.type' must be 'json_schema' or 'text'` |
| E | yes | json_schema (strict) | **Stall: no response in 300s**, same as C |

Conclusions:

- Strict `json_schema` constrained decoding is pathological on LM Studio for
  *both* models measured so far (qwen3.6 in phase 110, gemma-4 here). The
  measured local default is `none` across the board.
- `json_object` is not part of LM Studio's API at all — only `json_schema`
  or `text`. The mode stays in the enum for other OpenAI-compatible servers,
  but LM Studio profiles must never emit it.
- The `<|"|>` artifact appeared only on the tools-present live run (A), not
  in B — but tools-on is kodr's default path, so the S3 repair rule remains
  essential.
- gemma-4 populates `reasoning_content` on LM Studio (2,209 chars in B): it
  is a reasoning-channel model too, which fits the constrained-decode stall.
- Qwen3.6 measurements are phase 110's: strict json_schema → empty content
  or stalls; plain prompts → correct fix. Qwen default: `none`.

## Work items

### S1 — `structuredOutput` model-profile capability

Add `structuredOutput: 'json_schema' | 'json_object' | 'none'` to model
profiles. Measured defaults: `none` for all local/LM Studio profiles
(qwen3.6 per phase 110, gemma-4 per the table above); cloud/OpenRouter
profiles keep `json_schema` (current behavior there). User overrides via
`.kodr/model-profiles.json` keep working. LM Studio profiles must never emit
`json_object` (the server 400s) — validate the combination and fail loudly
at config load rather than at request time.

### S2 — Uniform constraint across all turn types

`applyResponseFormat` consults the profile's `structuredOutput` instead of
the provider+tools blanket rule, and the chosen mode applies identically to
main turns, the forced final turn, repair turns, and the E4 nudge turn. The
final-turn schema flip dies — with local mode measured as `none`, the forced
final turn must stop attaching json_schema (today it silently does, sending
the request shape that stalls both measured models on the turn that matters
most). Phase 110's "repairs never send response_format" special case becomes
"repairs follow the profile like every other turn" (same wire behavior for
local, now by rule instead of exception). The `shouldOmitResponseFormat`
provider+tools heuristic is deleted in favor of the profile mode.

### S3 — Decode-artifact repair pass

Add a targeted rule to `repairJsonText`: the literal pseudo-token `<|"|>`
becomes `"`. Fixture from the real gemma-smoke-2 response.md with provenance
comment. Keep the rule list data-driven enough that the next model's artifact
is a one-line addition.

### S4 — No-proposal stop engages healing

A `finish_stop` with substantial content but no extractable proposal must
enter the repair loop with a steering message (what was extracted, what
failed), the same way `invalid_proposal` does today. The E4 nudge remains the
first, cheaper line for *empty* content; this covers the non-empty case.

### S5 — Probe surfaces structured-output support

`kodr probe` reports the active profile's `structuredOutput` mode so a user
can see which constraint kodr will use before a run. (Auto-measuring support
in probe is deferred — the bench/probe measurement loop is a future phase;
record the idea in NEXT.md if not already there.)

## Testing

- Unit tests: profile resolution with the new field (defaults, overrides,
  unknown model fallback); `applyResponseFormat` per-mode and per-turn-type
  (including the forced-final-turn case that previously flipped); `<|"|>`
  repair with the real-response fixture; no-proposal-stop → healing entry at
  orchestration level with the fake model server.
- Full suite, `npm run format`, `npm run check` green.
- Live validation after implementation (run separately, sequentially): the
  gemma smoke greenfield task end-to-end with the measured default.

## Done criteria

- [x] Measurement table above filled with real variant results.
- [x] S1: `structuredOutput` in profiles with measured defaults and override
      support.
- [x] S2: one constraint mode per conversation — proven by a test asserting
      the forced final turn sends the same response_format as turn 1.
- [x] S3: gemma-smoke-2 fixture parses after the `<|"|>` repair rule.
- [x] S4: substantial-content no-proposal stop enters healing with steering.
- [x] S5: probe shows the mode.
- [x] `process/failures.jsonl` / `process/decisions.jsonl` updated.
- [x] Blog post `blog/112-measured-structured-output.md`.
- [x] NEXT.md entries shipped by this phase deleted (FIFO).
- [x] Version bumped to 0.0.112; suite green; committed.
