# Phase 111 — Proposal Extraction Resilience

Three models, three different failure modes, one layer.

## The layer that kept breaking

After phases 109 and 110 hardened the repair loop and instrumented the harness,
round-2 dogfooding put two real tasks through the system: a greenfield word-frequency
CLI and a brownfield feature addition. Both tasks failed at proposal extraction —
but in different ways. The gemma-4 smoke test from the same period added a third.

All three failures had the same shape: the model's response contained recoverable
substance that the extractor threw away.

## Three failures

**gemma-4: six blocks, three extracted.**

The gemma-4 smoke test emitted six consecutive ` ```json ` blocks, simulating
step-by-step execution. Block 1 was a planning envelope with `files: []`. Blocks
2 and 3 held the real `wordfreq.mjs` and its test file.

`extractJson` returned the *first* candidate that parsed. The planning block won.
Zero files were written.

The fence extractor was a regex: `` /```(?:json)?\s*([\s\S]*?)```/giu ``. When
six ` ```json ` lines appear in a row with no closing ` ``` ` between them, the
non-line-anchored lazy match pairs open-fences with open-fences instead of with
their closes. Three garbled blocks were extracted instead of six.

The fix: a line-anchored state machine. A fence-open is `/^```json\s*$/` at the
start of a line. A fence-close is `/^```\s*$/`. Consecutive ` ```json ` lines
without a close are treated as starting new blocks. All six are now enumerated.

**qwen3.6 greenfield: nested duplicate key silently drops a file.**

The logstats greenfield run failed all integration tests. The model emitted a
`files[]` entry with two `path` keys — `logstats.mjs` and
`test/logstats.test.mjs` — inside the same object. `JSON.parse` silently kept
the last key; the CLI was never written. Every test failed with `undefined` on
stdout.

`assertNoDuplicateTopLevelKeys` only walked depth-1 keys. Nested object keys
inside `files[]` entries were never checked.

The fix: the function is now `assertNoDuplicateKeys` and maintains a stack of
per-object key sets through the walk. Every object at any depth gets its own
set. Duplicate keys anywhere throw `Duplicate JSON key: <key>` before parsing.

**qwen3.6 brownfield: reasoning-then-silence.**

The model planned a complete correct feature addition in 4,117 reasoning tokens,
then emitted two newlines as content on a `stop` turn. `extractProposal` returned
null. The run failed with `ProposalMissingError`.

The silence pattern was exactly ` \n\n ` — two chars, zero non-whitespace. No
`response_format` was in play; this is broader than the phase-110 schema finding.

There was no nudge and no surface message. `kodr why` said "finish_stop."

The fix: when a stop turn returns zero non-whitespace chars with no extractable
proposal, send exactly one nudge: "Your last message was empty. Output the single
JSON proposal envelope now." One retry, never a loop, opt-in via
`options.nudgeEmptyTurn` (set by agents that must return a proposal). If the
final response is still near-empty, the terminal output now reads:
`Proposal: MISSING — response was empty (N chars)` instead of a bare `finish_stop`.

## The extraction design shift

Phase 110's principle was that the model's response is evidence. Phase 111
extends it: extraction should recover every valid proposal fragment the response
contains, not stop at the first candidate that parses.

`extractProposal` now walks all candidates, collects every valid proposal
envelope, and merges them: files are last-wins per path in document order
(so the real implementation block beats the planning envelope with `files: []`),
patches and messages are concatenated, status and scratchpad come from the last
envelope that sets them. Single-envelope responses behave exactly as before.

Extraction metadata — `candidateCount`, `proposalCount`, `merged` — is attached
to the returned proposal so `kodr why` and future diagnostics can surface
"proposal assembled from N blocks."

## The brace-walk abort

One more: `braceWalk` threw `JsonExtractionError` from inside `candidateTexts`,
before the per-candidate try/catch in `extractJson` could catch it. One malformed
brace region in the prose preamble would abort all candidate enumeration,
discarding valid fenced blocks too.

The gemma repair turn hit this: `repairs.json` showed
`stopReason: invalid_proposal, error: Unclosed JSON candidate`.

`candidateTexts` now catches brace-walk errors and retries from the next open
brace, bounded at 16 attempts. Fenced blocks are always enumerated regardless of
what the brace walk finds.

## What the test suite looks like

Before: 954 tests.

After: 972 tests. The 18 new tests are in `test/json-extractor.test.mjs`
(E1/E2/E3/E5 — including a fixture string derived from the real gemma response
artifact with a provenance comment) and `test/tool-calls.test.mjs` (E4 — three
orchestration-level cases against the existing fake model server).

The gemma fixture in the test file embeds the response structure verbatim, with
the provenance path noted, so the failure case is permanently part of the suite.
