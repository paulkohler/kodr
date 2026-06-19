# Phase 217: Staged Pipeline — Clear Applied Paths from ProposalDraft

## The failure that prompted this phase

Phase 216 added SafeWriteError steering so a model that tries to overwrite a
stage-1 file using `files[]` gets a `## Harness note` directing it to use
`edit_file` or `patches[]` instead. The steering message was correct and
specific — it named the conflicting paths.

The model ignored it.

Examining the tool responses revealed why. After stage 1 applied five files
to disk, stage 2 called `read_file` on those paths. The tool returned:

```
[pending write — not yet on disk]
content-from-stage-1
```

The `[pending write — not yet on disk]` label is what `getCapturedContent`
returns when a path exists in `proposalDraft._files`. The paths were still in
the draft because nothing had cleared them after stage 1 committed.

The model saw a harness note saying the files exist on disk, and a tool
response saying they are pending writes not yet on disk. It trusted the tool
response. From the model's point of view, the harness note was wrong. So it
re-issued `write_file` for all five files, which hit SafeWriteError again, and
the run stalled.

## Root cause

`proposalDraft` is shared across all stages — it is created once and passed
through `registry` into every `completeWithToolCalls` call in the stage loop.
After stage 1 calls `prepareChanges` and writes the files, the paths remain in
`proposalDraft._files` indefinitely. There was no mechanism to evict them.

Every `read_file` call checks `proposalDraft.getCapturedContent(path)` first.
If the path is present, it returns the captured content with the pending-write
label, regardless of whether the file is actually on disk. This is the correct
behaviour for a live proposal that hasn't been applied yet — but it is wrong
after application.

## The fix

Two changes, both small.

`ProposalDraft.clearFiles(paths)` in `src/tool-calls.mjs`:

```js
clearFiles(paths) {
    for (const path of paths) {
        this._files.delete(path);
    }
}
```

In `runStagedPrompt` (`src/run-pipeline.mjs`), immediately after
`allWrites.push(...writeResult.writes)`:

```js
const appliedPaths = writeResult.writes.map((w) => w.path);
registry?.proposalDraft?.clearFiles(appliedPaths);
```

After a stage commits, its file paths are evicted from the draft. The next
stage's `read_file` calls for those paths find nothing in the draft and fall
through to disk, returning the real content without the pending-write label.

The model now gets a consistent picture: the harness note says a file exists
on disk, and `read_file` returns actual content from disk. There is no
conflicting signal.

## Pattern in the staged pipeline evolution

Phases 213 through 217 have been a sequence of signal-consistency fixes:

- Phase 213: `run_command` guard intercepts test commands against pending writes.
- Phase 215: W3 draft fallback synthesises a proposal when text channel has no envelope.
- Phase 216: SafeWriteError at stage N > 1 steers rather than aborts.
- Phase 217: Applied paths are cleared from the draft so `read_file` returns disk state.

Each phase corrected a point where the harness sent the model a contradictory
or misleading signal. The model is not the problem in any of these cases — it is
acting on the information it has. The fixes are all in the harness.
