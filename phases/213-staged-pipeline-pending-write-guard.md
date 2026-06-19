# Phase 213 — Staged Pipeline Pending-Write run_command Guard

## Goal

Phase-212 dogfooding: both Node.js runs failed with `stopReason:staged /
ProposalMissingError`. The model writes all files correctly via `write_file` tool
calls, then calls `run_command` to verify tests against files not yet on disk (they
are pending writes in `proposalDraft`, not yet applied). The `run_command` either
crashes or hangs, the model tries again, and eventually the tool budget is exhausted
with no JSON envelope returned.

Root cause: the `run_command` handler in `tool-calls.mjs` runs unconditionally even
in proposal mode. The model's own reasoning says "return the JSON proposal" but the
tool-result context biases it toward another tool call.

## Fix

In the `run_command` handler (`src/tool-calls.mjs` line ~817), add a guard:

```js
handler: async ({ command, timeoutMs }) => {
    if (applyMode === 'proposal' && proposalDraft && !proposalDraft.isEmpty) {
        const pendingPaths = proposalDraft.files.map(f => f.path);
        if (pendingPaths.some(p => command.includes(p))) {
            return {
                error: 'Files have not been applied to disk yet — run_command cannot access pending writes.',
                hint: 'Return the final JSON proposal envelope now. The harness will apply your writes and run verification automatically.',
            };
        }
    }
    return runVerification(cwd, command, {
        runner: options.commandRunner || null,
        timeoutMs,
    });
},
```

The `proposalDraft` variable is already in scope via closure at the `run_command`
registration site. `proposalDraft.files` is the array of captured `{ path, content }`
entries populated by prior `write_file` calls.

The check is substring-based: if any pending path string appears anywhere in the
command string, the guard fires. This catches `node --test test/notes.test.mjs` when
`test/notes.test.mjs` is a pending write. It cannot fire in live mode (`applyMode`
is not `'proposal'`) or when the draft is empty.

## Files to change

### `src/tool-calls.mjs`

- In `createBuiltinRegistry`, in the `run_command` handler, add the pending-write
  guard before the `runVerification` call.
- The `proposalDraft` variable is in scope via closure — no additional params needed.

### `test/tool-calls.test.mjs`

Add a suite `run_command pending-write guard (Phase 213)` with tests:

1. Returns synthetic error when command references a pending-write path in proposal mode.
2. Does NOT fire when `applyMode` is `'live'` (draft has files but mode is live).
3. Does NOT fire when draft is empty (no pending writes).
4. Does NOT fire when command does not reference any pending path.

Use a real `createBuiltinRegistry` call with a mock `commandRunner` and a fake
`proposalDraft` (or use `write_file` tool calls to populate the draft before calling
`run_command`).

## Done criteria

- [x] Pending-write guard added to `run_command` handler.
- [x] Guard fires only in proposal mode with non-empty draft and path match.
- [x] 4 new tests pass.
- [x] All existing tool-calls tests pass.
- [x] `npm run format && npm run check` clean.
- [x] `process/decisions.jsonl` entry added.
- [x] Blog post exists.
- [x] Roadmap entry marked done.
- [x] Commit made.
