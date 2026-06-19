# Phase 220 — Staged-Mode Repeat-Sentinel Wording

## Goal

Phase-219 dogfooding: in staged mode, the escalation message "Return your final
proposal now" redirected the model to return a plain-text summary rather than
calling `write_file` for the remaining files. The message is correct for the
non-staged flow where the model holds a pending JSON proposal envelope, but
misleads staged-pipeline runs where the model writes one file at a time via
tool calls and has no pending envelope to return.

Fix: detect staged mode and substitute staged-specific wording at both escalation
levels.

## Changes

### `src/tool-calls.mjs` — `completeWithToolCalls`

`completeWithToolCalls(options, model, prompt, systemPrompt, registry, extras)`
already receives `options`. Add a check for `options.inStagedPipeline` in the
repeat sentinel branch.

Replace the two sentinel strings in the escalation block (~line 428-442):

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

### `src/run-pipeline.mjs` — `runStagedPrompt`

When calling `completeWithToolCalls` inside the stage loop (~line 1917), pass
`inStagedPipeline: true` via options:

```js
const completion = await completeWithToolCalls(
    { ...options, inStagedPipeline: true },
    model,
    stagePrompt,
    stageContext.systemPrompt,
    registry,
);
```

### `test/tool-calls.test.mjs`

Add a `repeat sentinel — staged mode wording` suite:

1. First repeat in staged mode returns staged wording (no "Return your final proposal").
2. Escalation (count ≥ 3) in staged mode returns staged escalation wording (no "Return your final proposal").
3. Non-staged mode still returns envelope wording ("Return your final proposal now").
4. `inStagedPipeline` defaults to false when not set (envelope wording used).

## Done criteria

- [x] `options.inStagedPipeline` checked in repeat sentinel branch.
- [x] Staged wording redirects to `write_file` and suppresses test/install attempts.
- [x] Non-staged wording unchanged.
- [x] 4 new tests pass.
- [x] `npm run format && npm run check` clean.
- [x] `process/decisions.jsonl` entry added.
- [x] Blog post exists.
- [x] Roadmap entry marked done.
- [x] Commit made.
