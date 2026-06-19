# Phase 215 — runStagedPrompt: Tool-Channel Draft Fallback

## Goal

Phase-213 dogfooding confirmed the pending-write guard fires correctly but runs still
fail with `ProposalMissingError`. Root cause: `runStagedPrompt` (run-pipeline.mjs
~line 1928) calls `extractProposal(completion.text)` and on null jumps immediately to
`ProposalMissingError`. It never inspects `completion.proposalDraft`.

The main pipeline (line 948-1078) has a `draftNonEmpty` fallback: when
`extractProposal` returns null but `proposalDraft` is non-empty, it calls
`mergeProposalWithDraft(capturedDraft, null)` to synthesize the proposal from the
tool-channel writes. The staged path is missing this fallback entirely.

Secondary: the Phase-213 guard intercepts `run_command` calls that contain a pending
path literal, but `node --test` (no explicit path) slipped through. Extend the guard
to also intercept bare test-runner invocations when the draft is non-empty.

## Changes

### `src/run-pipeline.mjs` — `runStagedPrompt`

At the `if (!proposal)` block (around line 1943), add a draft fallback before
declaring `ProposalMissingError`:

```js
if (!proposal) {
    // W3 fallback (mirrors main pipeline line 1068): if tool-channel writes
    // captured the stage's files, synthesize the proposal from the draft.
    const capturedDraft = completion.proposalDraft ?? null;
    if (capturedDraft && !capturedDraft.isEmpty) {
        proposal = mergeProposalWithDraft(capturedDraft, null);
    }
}
if (!proposal) {
    writeError = {
        message: 'Staged response did not include a proposal',
        name: 'ProposalMissingError',
    };
    stageRecords.push({
        error: writeError,
        name: `implement-${stageIndex}`,
        responseChars: completion.text.length,
    });
    break;
}
```

`mergeProposalWithDraft` is already imported and used in the main pipeline path in
the same file.

### `src/tool-calls.mjs` — `run_command` guard (Phase 213 extension)

Extend the existing guard to also block bare test-runner commands when the draft is
non-empty. The guard should intercept when:
- Any pending path appears in the command string (existing check), OR
- The command matches a test-runner pattern AND the draft is non-empty

```js
const TEST_RUNNER_RE = /^(node\s+--test|npm\s+(run\s+)?test|yarn\s+test|pnpm\s+test|pytest|python3?\s+-m\s+unittest|go\s+test|cargo\s+test)\b/;

if (
    applyMode === 'proposal' &&
    proposalDraft &&
    !proposalDraft.isEmpty &&
    (pendingPaths.some(p => command.includes(p)) || TEST_RUNNER_RE.test(command.trim()))
) {
    return {
        error: 'Files have not been applied to disk yet — run_command cannot access pending writes.',
        hint: 'Return the final JSON proposal envelope now. The harness will apply your writes and run verification automatically.',
    };
}
```

## Tests

### `test/run-pipeline.test.mjs` (or equivalent staged-prompt test file)

Find the existing staged-prompt tests. Add:

1. Draft-fallback: staged run where model writes files via `write_file` and returns
   a stop turn with no JSON envelope → proposal is synthesized from `proposalDraft`,
   `writeCount > 0`, no `ProposalMissingError`.
2. Draft empty: staged run where model returns no files and no envelope → still
   `ProposalMissingError` (fallback doesn't fire on empty draft).

### `test/tool-calls.test.mjs`

Add 2 tests to the Phase 213 suite or a new suite:

3. Bare `node --test` (no path) fires guard when draft is non-empty.
4. Bare `node --test` does NOT fire guard when draft is empty.

## Done criteria

- [x] Draft fallback added to `runStagedPrompt`.
- [x] Guard extended to block bare test-runner commands when draft non-empty.
- [x] Tests for staged draft-fallback pass.
- [x] Tests for extended guard pass.
- [x] All existing staged/tool-calls tests still pass.
- [x] `npm run format && npm run check` clean.
- [x] `process/decisions.jsonl` entry added.
- [x] Blog post exists.
- [x] Roadmap entry marked done.
- [x] Commit made.
