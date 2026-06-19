# Phase 217 — Staged Pipeline: Clear Applied Paths from ProposalDraft

## Goal

Phase-216 dogfooding traced the root cause of the steering-note failure: the
`proposalDraft` is shared across all stages (via the registry passed to
`completeWithToolCalls`). After stage 1 applies files to disk, those paths remain
in `proposalDraft._files`. When stage 2 calls `read_file` on those paths,
`getCapturedContent` returns the stage-1 content with a `[pending write — not yet
on disk]` label, even though the files are on disk. The model's tool-response
contradicts the `## Harness note`, and it re-issues `write_file`.

Fix: after each stage's `prepareChanges` succeeds, call a new `clearFiles(paths)`
method on the shared `proposalDraft` to remove the applied entries. Subsequent
`read_file` calls then fall through to disk.

## Changes

### `src/tool-calls.mjs` — `ProposalDraft`

Add a `clearFiles(paths)` method:
```js
// Remove file entries for already-applied paths so read_file goes to disk.
clearFiles(paths) {
    for (const path of paths) {
        this._files.delete(path);
    }
}
```

### `src/run-pipeline.mjs` — `runStagedPrompt`

After `prepareChanges` succeeds (after `allWrites.push(...writeResult.writes)` at
~line 2046), clear the applied paths from the shared draft:

```js
// Clear applied file paths from the shared draft so read_file in the next
// stage reads from disk rather than returning stale pending-write labels.
const appliedPaths = writeResult.writes.map((w) => w.path);
registry?.proposalDraft?.clearFiles(appliedPaths);
```

`registry` is available in scope — it is passed to `completeWithToolCalls` as the
5th argument in each stage iteration, which means it is defined in the enclosing
`runStagedPrompt` scope. Confirm by searching for where `registry` is declared in
that function.

### `test/tool-calls.test.mjs`

Add a `ProposalDraft.clearFiles` suite with 3 tests:

1. `clearFiles` removes entries so `getCapturedContent` returns null for cleared paths.
2. `clearFiles` does not affect entries for uncleaned paths.
3. `clearFiles` with an empty array is a no-op.

## Done criteria

- [x] `clearFiles(paths)` added to `ProposalDraft`.
- [x] Called in `runStagedPrompt` after each successful stage apply.
- [x] 3 new tests pass.
- [x] All existing tool-calls and staged-prompt tests pass.
- [x] `npm run format && npm run check` clean.
- [x] `process/decisions.jsonl` entry added.
- [x] Blog post exists.
- [x] Roadmap entry marked done.
- [x] Commit made.
