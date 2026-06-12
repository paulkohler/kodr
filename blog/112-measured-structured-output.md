# Phase 112 — Measured Structured Output

We thought constrained decoding would save gemma. Measurement said the opposite.
The real bug was kodr flipping the output contract on the final turn.

## The hypothesis that failed

After phase 111's extraction fixes, gemma-4 still failed. The model emitted a
literal `<|"|>` pseudo-token in place of closing quotes inside JSON strings,
corrupting every envelope. A natural next step: force the model to emit valid
JSON by turning on strict `json_schema` constrained decoding.

The A/B we ran before writing a line of code killed that idea fast.

## The measurements

Five variants of the exact saved gemma-smoke-2 request, replayed against LM
Studio (`google/gemma-4-26b-a4b`), scored with kodr's own extractor:

| Variant | tools | response_format | Outcome |
|---|---|---|---|
| A (live run) | yes | none | 5 fenced blocks, 7 `<|"|>` artifacts, no proposal |
| B | no | none | **Clean: 22.6s**, finish `stop`, 6 fenced blocks, 0 artifacts |
| C | no | json_schema (strict) | **Stall: no response in 300s** |
| D | no | json_object | **Rejected by LM Studio, HTTP 400** |
| E | yes | json_schema (strict) | **Stall: no response in 300s** |

Variant C stalled at 13× the unconstrained latency and never returned. LM
Studio doesn't implement `json_object` at all. Unconstrained variant B worked in
22 seconds and gemma's `reasoning_content` (2,209 chars) confirmed it's a
reasoning-channel model — the same class of model that qwen3.6 belongs to, and
the same class that stalls on constrained decode in phase 110.

Conclusions locked in before implementation:

- Strict `json_schema` is pathological on LM Studio for every reasoning model
  measured so far. The measured local default is `none`.
- `json_object` is not available on LM Studio; profiles must never emit it.
- The `<|"|>` artifact appeared only in the tools-present run (A), so the S3
  repair rule is still necessary even though constrained decode is off.

## The bug we found along the way

While investigating how kodr sends JSON constraints, a structural bug surfaced.

Phase 109's final-turn forcing (F1) removes `tools` from the request body so
the model must produce a final text answer. The old constraint logic —
`shouldOmitResponseFormat` — checked `body.tools.length > 0` to decide whether
to suppress `response_format` for local providers. F1's body transformation
removed `tools`, which made `shouldOmitResponseFormat` stop matching. On exactly
the final turn, `json_schema` silently reattached.

The model experienced a different output contract on the turn that mattered most.
For reasoning models on LM Studio, this is the configuration that produces empty
content or 300-second stalls.

The repair turns (phase 110) and E4 nudge turn had their own special cases. Each
turn type had its own workaround. None of them were coherent.

## What phase 112 ships

**S1 — structuredOutput profile field.** The profile registry gains
`structuredOutput: 'json_schema' | 'json_object' | 'none'`. Measured defaults:
`none` for all local/LM Studio profiles, `json_schema` for OpenRouter. User
overrides via `.kodr/model-profiles.json` work as before. Profiles that set
`json_object` for LM Studio providers fail loudly at config load — not at
request time.

**S2 — Uniform constraint across all turn types.** `shouldOmitResponseFormat`
is deleted. The profile's `structuredOutput` mode is the single source of truth
and applies identically to main turns, the forced final turn, repair turns, and
the E4 nudge turn. For local runs the measured default is `none` — so none of
those turns get `response_format`, by rule, not by workaround. The repair
options special-case (`responseFormat: undefined`) is removed; local mode
produces the same wire behavior through the profile.

**S3 — Decode-artifact repair.** `repairJsonText` gains a data-driven rule list.
The first entry: `<|"|>` → `"`. The rule is structured as a one-liner per new
model artifact so the next decode failure is a single-line addition. Fixture
sourced from the real gemma-smoke-2 response.md (7 occurrences confirmed).

**S4 — No-proposal stop engages a steer.** A `finish_stop` with substantial
content but no extractable proposal now sends one steering message before
declaring failure. This covers the gemma-4 prose-then-stop pattern where the
model narrates its plan but forgets to emit the JSON envelope. The E4 empty-turn
nudge stays first for whitespace-only content; S4 covers the non-empty case.
Gate: only fires when `responseFormatForRequest` returns non-null (the model was
actually sent a constraint), so local mode prose responses are not interrupted.

**S5 — Probe surfaces the mode.** `kodr probe` now prints
`Structured output: <mode>` in human-readable output and includes
`structuredOutputMode` in the JSON result, so the user can see which constraint
kodr will use before running a task.

## What gemma needs now

The `<|"|>` repair (S3) and the no-proposal steer (S4) are in place for the
next live validation run. The A/B artifacts are at
`~/src/kodr-testing/phase-112/ab-structured-output/`. The next live gemma run
should succeed: unconstrained + tools, extraction + merge from phase 111,
decode-artifact repair from S3, and the S4 steer if the model narrates instead
of proposing.

The live validation run is scheduled separately — LM Studio is reserved during
harness development.
