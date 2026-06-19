# Phase 219 — Repeat-Sentinel Escalation After N Identical Tool Calls

## Goal

Phase-214 dogfooding: model called `node --test` 9 times consecutively. Each
returned `{ repeat: true, message: "This exact tool call was already made..." }`.
The model never broke out. The current sentinel is a weak one-size-fits-all response
that does not escalate and the model ignores after a few turns.

Fix: track repeat count per call key. After `N=3` consecutive repeats of the same
call, return a stronger escalation message that is harder for the model to ignore.

## Changes

### `src/tool-calls.mjs` — `completeWithToolCalls`

Change `seenToolCalls` from `Map<callKey, boolean>` to `Map<callKey, count>`:

```js
// Was: const seenToolCalls = new Map();
// seenToolCalls.set(callKey, true);
// seenToolCalls.has(callKey)

// New: track count so repeat N fires escalation
const seenToolCalls = new Map(); // Map<callKey, count>
```

In the repeat branch (currently at ~line 415-421):
```js
if (seenToolCalls.has(callKey)) {
    const count = seenToolCalls.get(callKey) + 1;
    seenToolCalls.set(callKey, count);
    const ESCALATION_THRESHOLD = 3;
    content = count >= ESCALATION_THRESHOLD
        ? JSON.stringify({
              repeat: true,
              count,
              message:
                  `You have made this identical tool call ${count} times. ` +
                  'Stop retrying. Return your final proposal now — the harness will apply writes and run verification automatically.',
          })
        : JSON.stringify({
              repeat: true,
              count,
              message:
                  'This exact tool call was already made. Stop calling tools and return the final JSON proposal now.',
          });
} else {
    seenToolCalls.set(callKey, 1);
    // ... run tool
}
```

The escalation message at count ≥ 3 explicitly names the count and adds "the
harness will apply writes and run verification automatically" — removing the model's
incentive to verify before submitting.

### `test/tool-calls.test.mjs`

Update or add tests for the new repeat behaviour:

1. First repeat (count=1) returns standard message (no escalation text).
2. Second repeat (count=2) returns standard message.
3. Third repeat (count=3) returns escalation message containing the count and "Stop retrying".
4. Fourth repeat (count=4) still returns escalation message.
5. Different tool calls don't share counts (tool A × 3 does not affect tool B).

## Done criteria

- [x] `seenToolCalls` tracks count (not boolean).
- [x] Escalation fires at count ≥ 3 with stronger message.
- [x] 5 new/updated tests pass.
- [x] `npm run format && npm run check` clean.
- [x] `process/decisions.jsonl` entry added.
- [x] Blog post exists.
- [x] Roadmap entry marked done.
- [x] Commit made.
