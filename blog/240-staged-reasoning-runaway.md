# Phase 240: Staged Reasoning-Runaway Fast-Fail

The phase-238 audit of a rest-api-sqlite run recorded turn 11 of a staged
implement loop. The model had a 32,768 token context. The prompt was 9,709 tokens.
That left 23,059 tokens for the answer. The model used every one of them on
chain-of-thought reasoning, produced zero answer characters, and returned
`finish_reason=length`. The harness got `ProposalMissingError` and aborted the
stage. Nothing was written.

The failure is identical to the one phase 231 caught in heal turns. The machinery
for detecting it already existed: `isReasoningRunaway` in `healing.mjs` tests
for `finish_reason=length` with empty content and no captured tool-write draft.
Heal turns wired this predicate in phase 231. Staged implement turns did not.

## Why not a blanket cap?

The symmetry to heal turns is real, but the fix cannot be identical.

Phase 236 ran a targeted probe: set the `completionReserve` cap (4,096 tokens)
on a realistic two-file generate turn. The thinking model spent all 4,096 tokens
on reasoning and emitted zero answer characters. The uncapped turn for the same
task needed about 10,600 completion tokens and succeeded. A blanket cap on staged
turns would produce the same starvation on every large file generation, not just
on runaways.

The safer answer is detect-and-retry:

1. After each staged implement turn, check `isReasoningRunaway(completion.text, completion, false)`. The draft check (`!stageDraftNonEmpty`) ensures a native write-tool capture is never misclassified.
2. If it fires: retry once with `completionCapMode:'staged-retry'`. This mode uses `max(completionReserve, 8192)` instead of the bare `completionReserve`. The 8,192 floor is the minimum safe bound from the phase-236 probe.
3. If the retry also runaways or produces no proposal: fall through to `ProposalMissingError`. No infinite loop.

## The `staged-retry` completion mode

`applyCompletionCap` in `model-client.mjs` previously only honored the `'heal'`
marker. Phase 240 extends it to `'staged-retry'` with different arithmetic:

```
heal:         cap = completionReserve (tight, intentional fast-fail)
staged-retry: cap = max(completionReserve, 8192) (floor prevents starvation)
```

The conditional is exhaustive: no other mode triggers a cap. The main loop and
normal staged turns remain uncapped, preserving the known-good pre-234 wire shape.

## What the stage record carries

When a retry fired and succeeded, the implement stage record now includes:

```json
{
  "name": "implement-1",
  "runawayRetry": true,
  "runaway": {
    "finishReason": "length",
    "completionTokens": 23000,
    "promptTokens": 9709,
    "totalTokens": 32709,
    "stageIndex": 1
  },
  "writeCount": 3,
  ...
}
```

The `summary.staged.runawayRetries` count accumulates across all stages so a
single forensics field shows whether any retry fired during the run.

## The stop+empty regression guard

`isReasoningRunaway` returns false when `finish_reason=stop` with empty content.
`stop`+empty is a legitimate model decline, a nudge target for E4 (the existing
empty-turn recovery path), not a runaway. Test C verifies this: the stage record
for a stop+empty turn has no `runawayRetry` field and `staged.runawayRetries` is
absent. The E4 nudge fires (existing pipeline behavior), but no staged-retry fires.

## Tests

Three new tests in `test/staged-pipeline.test.mjs`:

- **(A) retry succeeds**: stage record has `runawayRetry: true`, file is written, `staged.runawayRetries === 1`.
- **(B) double-runaway**: retry also runaways, `writeError.name === 'ProposalMissingError'`, exactly three model calls (plan + runaway + one retry, not more).
- **(C) stop+empty guard**: no `runawayRetry` on the stage record, `staged.runawayRetries` absent.

Four new tests in `test/model-client.test.mjs` cover the `staged-retry` mode:
floor wins when `completionReserve < 8192`, `completionReserve` wins when it
exceeds the floor, caller override still wins, and the floor applies when
`completionReserve` is absent.
