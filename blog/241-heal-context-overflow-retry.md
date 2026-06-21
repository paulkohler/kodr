# Phase 241: Heal Context-Overflow Retry

Two separate dogfoods reproduced the same failure: a heal repair turn returning
`stopReason: 'repair_error'` after an HTTP 400 "Context size has been exceeded."
Both came after context-heavy staged runs. The first was `phase-231/heal-runaway-3`
turn 3. The second was `final-audit-2/content-api` turn 1.

The naive explanation was that kodr was over-sending the repair prompt. That did
not hold.

## Disproving the prompt-size hypothesis

The `final-audit-2/content-api` turn-1 artifact was conclusive:

- `repair-context.json` had `files: []` — an empty repair context.
- The prompt was ~14k characters, roughly 3–4k tokens.
- There was no `raw-response.json`. The request 400'd on the very first sub-turn,
  before any tool-call sub-turns accumulated.
- The main loop had run 77k cumulative prompt tokens across its turns.

A 14k prompt cannot exceed a 32k context window on its own. The 400 was not a
function of the repair prompt size.

## The real cause

Kodr sends no session IDs and no KV-cache hints. Every heal request is a fresh
stateless HTTP POST to `/v1/chat/completions`. There is nothing in the request that
could carry the main loop's context forward.

The cause is LM Studio-side: its internal KV-cache from the heavy main loop occupies
GPU memory, and LM Studio erroneously counts that cached state against the context
budget for the next incoming request. The server sees a "full" context that includes
the prior loop's entries, even though kodr sent a clean prompt.

## The fix

Three changes, parallel to how phase 231 handled reasoning runaways in heal turns.

**`isContextOverflow(error)`** exported from `model-client.mjs`: returns true when
the error is a `ModelClientError` with HTTP 400 status and a message matching
`/context.size|context window|exceeded/i`. This predicate is the detection boundary.

**Retry in `run-pipeline.mjs`**: the `repairTurn` callback wraps the completion
call in a try-catch. On a first context-overflow error, it increments a
`contextOverflowRetries` counter, waits 200ms (giving LM Studio a window to flush
its session state), and calls again. If the retry also throws, that error propagates
to `healing.mjs`'s catch block. A counter per `runHealingIfNeeded` invocation is
included as `healContextOverflowRetries` in `summary.json` when non-zero.

**`repair_context_overflow` stop reason in `healing.mjs`**: the catch block now
checks `isContextOverflow(error)` before falling to the generic `repair_error`
branch. When the retry also 400s, the loop surfaces `repair_context_overflow`
instead of the opaque `repair_error`. The distinct stop reason makes LM Studio
KV-cache bleed diagnosable from `summary.json` without manual artifact inspection.

## Symmetry with phase 231

Phase 231 introduced `isReasoningRunaway` to detect and fast-fail reasoning runaways
in heal turns. Phase 241 does the same shape of thing for a different failure class:
detect a specific server-side failure, retry once, and surface a distinct stop reason
if the retry also fails. Both follow the principle that opaque error names (`repair_error`,
`error`) are diagnosis dead-ends; named stop reasons are the right artifact to record.

## Tests

Seven new tests across two files:

- **`isContextOverflow` unit tests (model-client.test.mjs)**: HTTP 400 with
  "Context size" returns true; "context window exceeded" variant returns true;
  HTTP 400 without context message returns false; HTTP 500 with context message
  returns false; plain `Error` (not `ModelClientError`) returns false.

- **Double-failure test (healing.test.mjs)**: `repairTurn` always throws a
  context-overflow error. Assert `stopReason === 'repair_context_overflow'`,
  `healed === false`, one repair entry with `ok === false`.

- **Non-context-overflow 400 test (healing.test.mjs)**: `repairTurn` throws an
  HTTP 400 with a different message. Assert `stopReason === 'repair_error'` — the
  new branch must not over-classify.
