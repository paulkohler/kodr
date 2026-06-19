# Phase 220: Staged-Mode Repeat-Sentinel Wording

## The failure that prompted this phase

Phase-219 dogfooding introduced count-based escalation in the repeat sentinel. After
three identical tool calls, the model receives:

```json
{
  "repeat": true,
  "count": 3,
  "message": "You have made this identical tool call 3 times. Stop retrying. Return your final proposal now — the harness will apply writes and run verification automatically."
}
```

In a non-staged run, this is correct. The model holds a JSON proposal envelope in its
context, and "return your final proposal now" tells it to emit that envelope. The
harness extracts the envelope, applies the files, and runs verification.

In staged mode, there is no pending proposal envelope. The model writes one file at a
time via `write_file` tool calls, and the harness applies each stage's writes
immediately. When the escalation fired in staged mode, the model interpreted "return
your final proposal" as: produce a text summary of what you would have done. It
replied with a markdown list of files it had planned to write — no tool calls, no
files. The stage completed with zero writes, and the run stalled.

## Why the same message does opposite things

In non-staged mode the model has been constructing a JSON envelope through the
conversation. "Return your final proposal" is a recognisable pattern from the system
prompt: it knows the shape of a valid proposal and produces one.

In staged mode the system prompt describes a different contract: write files one stage
at a time via `write_file`. The model has never been told about a proposal envelope.
When it hears "return your final proposal now", it falls back to the nearest natural
language interpretation — a proposal is a plan, so it writes a plan.

The escalation message is designed to interrupt a stuck loop. It worked in non-staged
runs because the escape route ("return the proposal") matched the model's established
contract. In staged mode the escape route was ambiguous, and the model chose the wrong
one.

## The fix: mode-specific wording

The sentinel branch in `completeWithToolCalls` now reads `options.inStagedPipeline`
and branches on it:

```js
const staged = options.inStagedPipeline === true;
content =
    count >= ESCALATION_THRESHOLD
        ? JSON.stringify({
              repeat: true,
              count,
              message: staged
                  ? `You have made this identical tool call ${count} times. ` +
                    'Stop retrying. Call write_file for the next file you need to write. ' +
                    'Do not run tests or npm install — verification runs automatically after all stages complete.'
                  : `You have made this identical tool call ${count} times. ` +
                    'Stop retrying. Return your final proposal now — the harness will apply writes and run verification automatically.',
          })
        : JSON.stringify({
              repeat: true,
              count,
              message: staged
                  ? 'This exact tool call was already made. ' +
                    'Call write_file for the next file you need to write. ' +
                    'Do not run tests or npm install.'
                  : 'This exact tool call was already made. Stop calling tools and return the final JSON proposal now.',
          });
```

`runStagedPrompt` now spreads `inStagedPipeline: true` into options when calling
`completeWithToolCalls`, so the flag reaches the sentinel branch without touching any
other caller.

## What staged wording says differently

The non-staged escalation says: "Return your final proposal now." It invokes the
proposal contract and trusts the model knows what that means.

The staged escalation says: "Call write_file for the next file you need to write. Do
not run tests or npm install — verification runs automatically after all stages
complete."

Three things change:

1. The escape route is concrete — a specific tool call (`write_file`), not an abstract
   concept (the proposal).
2. The test/install prohibition is explicit. Staged runs commonly hit the repeat
   sentinel when the model loops on `run_command` with `node --test` or `npm install`.
   Naming those specifically removes any ambiguity about what "stop retrying" means for
   the stuck pattern.
3. "Verification runs automatically after all stages complete" reframes the model's
   incentive in staged-mode terms — parallel to the envelope version's "the harness
   will apply writes and run verification automatically."

## The pattern

This is the third time a sentinel or steering message has been found to have
mode-specific semantics. Phase 213 added a pending-write guard for `run_command` that
mentions the proposal envelope — that guard should probably also branch on staged mode
(the hint "Return file changes in the final JSON proposal" is as wrong as "return your
final proposal now"). Phase 216 already has staged-specific SafeWriteError steering.

The right generalisation is: any message that references the proposal envelope is wrong
in staged mode, and vice versa. The `inStagedPipeline` flag is already threaded
through enough of the call chain that adding checks is cheap.

## Tests

Four new tests cover the wording branches:

1. First repeat (`count=2`) in staged mode: message includes `write_file`, no "Return
   your final proposal".
2. Escalation (`count>=3`) in staged mode: message includes "Stop retrying" and
   `write_file`, no "Return your final proposal".
3. Escalation in non-staged mode: message includes "Return your final proposal now".
4. `inStagedPipeline` absent: behaves as non-staged, uses envelope wording.

All four use the fake model server pattern established in Phase 219 tests.
