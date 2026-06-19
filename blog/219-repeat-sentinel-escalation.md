# Phase 219: Repeat-Sentinel Escalation After N Identical Tool Calls

## The failure that prompted this phase

Phase 214 dogfooding produced a run where the local model called `node --test` nine
times in a row. Each time, the harness returned the same sentinel response:

```json
{"repeat":true,"message":"This exact tool call was already made. Stop calling tools and return the final JSON proposal now."}
```

The model read this, generated another `tool_calls` turn with the same arguments, and
got the same message again. This continued for all nine turns until the turn budget
exhausted. The run ended with `stopReason: turn_budget_exhausted` and no proposal.

## Why a single invariant message fails

The sentinel fires on a deduplication check — the call key (tool name + arguments
string) is already in `seenToolCalls`. The original implementation stored `true` as
the map value. Every repeat, regardless of how many times the model had already been
told to stop, received the same message.

A model stuck in a loop has no increasing pressure to change behaviour. The message
says "stop calling tools" but the loop state doesn't encode any escalation. After
nine identical rejections with identical responses, the model still hasn't gotten a
signal meaningfully different from the first.

## The fix: count-based escalation

`seenToolCalls` was changed from `Map<callKey, boolean>` to `Map<callKey, count>`.

On the first call for a key, execution runs normally and the key is recorded with
`count = 1`. On each repeat, the count increments before the synthetic response is
built:

```js
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
```

At count 2 and below the threshold, the model gets the standard message plus the
count so it can see the accumulation. At count 3 and above, the escalation message
fires. It names the count explicitly ("You have made this identical tool call 3
times") and adds "the harness will apply writes and run verification automatically."

## Why the escalation message is different in kind

The standard message says "stop calling tools" — a prohibition. The escalation message
removes the model's incentive to keep retrying by asserting that verification is the
harness's job, not the model's.

Models stuck on a test-runner loop are typically in a verification mindset: they want
to see a green result before submitting. The escalation message reframes the situation:
the harness runs verification after apply, so running the test tool before submitting
is not just redundant — it's the exact thing blocking progress. The phrasing is chosen
to interrupt that reasoning pattern rather than just repeat the prohibition louder.

## The `count` field

Both the standard and escalation messages include `count` in the JSON object. This
gives the model a visible number it can reference, and it gives test assertions a
clean way to verify threshold behaviour without parsing message text.

## What the tests cover

Five scenarios are tested via `completeWithToolCalls` driven by a fake model server:

1. First repeat (count=2): standard message, no "Stop retrying".
2. Third call overall / second repeat (count=3): escalation fires, message includes
   count and "Stop retrying".
3. Fourth call overall (count=4): escalation still fires.
4. Different tool calls have independent counts — `list_files` reaching count=3 does
   not affect `read_file`'s count, which starts at 1 on its first call and reaches
   only 2 on its first repeat (no escalation).
5. The existing test was updated to also assert `count=2` on the first repeat.

## The broader pattern

Phases 213, 215, 216, and 219 are all responses to the same class of stuck-model
failure. Phase 213 blocked test-runner calls against pending writes. Phase 215 added
a draft fallback so a completed tool-channel run doesn't need a text envelope. Phase
216 steered the staged pipeline past `SafeWriteError`. Phase 219 escalates the
repeat sentinel so a stuck loop experiences increasing pressure to stop.

Each fix handles a specific loop state that the model could previously cycle through
indefinitely. The pattern is: identify the cycle, find what information would break
it, inject that information at the right moment.
