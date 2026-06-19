# Phase 216 — Staged Pipeline: SafeWriteError Steering

## Goal

Phase-215 dogfooding: draft fallback resolved `ProposalMissingError` but the run hit
a new blocker — `SafeWriteError` when implement-2 tried to overwrite files written by
implement-1 using `files[]`. The model correctly self-diagnosed the bug and produced
full fixed rewrites, but `protectExisting` blocked them and the stage aborted.

The current catch block at `run-pipeline.mjs ~line 2032` treats ALL errors from
`prepareChanges` as fatal and `break`s the stage loop. For `SafeWriteError` in stages
after the first (stageIndex > 1), the right response is to steer the next stage to
use `edit_file`/`patches[]` instead of `files[]`, not to abort the run.

## Changes

### `src/run-pipeline.mjs` — `runStagedPrompt`

**Imports** — add `access` to the `node:fs/promises` import, and `SafeWriteError`
to the `./safe-writes.mjs` import.

**Before the stage loop**, add:
```js
let safeWriteSteering = null;
```

**Stage prompt assembly** (lines 1899-1912) — add the steering note after the
scratchpad entry:
```js
safeWriteSteering
    ? `\n## Harness note\n${safeWriteSteering}`
    : '',
```
Reset `safeWriteSteering = null` immediately after building the prompt (before
`completeWithToolCalls`) so it only applies to one stage.

**In the `prepareChanges` catch block** (lines 2032-2043), intercept `SafeWriteError`
for `stageIndex > 1`:

```js
} catch (error) {
    if (stageIndex > 1 && error instanceof SafeWriteError) {
        // Find ALL files[] entries that already exist on disk and list them
        // in the next stage's prompt so the model uses edit_file/patches[].
        const conflicts = (
            await Promise.all(
                (proposal.files ?? []).map(async (f) => {
                    try {
                        await access(join(io.cwd, f.path));
                        return f.path;
                    } catch {
                        return null;
                    }
                }),
            )
        ).filter(Boolean);
        const listed =
            conflicts.length > 0
                ? conflicts.map((p) => `\`${p}\``).join(', ')
                : `\`${error.message}\``;
        safeWriteSteering =
            `These files already exist on disk. Use \`edit_file\` or ` +
            `\`patches[]\` to modify them — \`files[]\` is only for new files: ${listed}.`;
        stageRecords.push({
            name: `implement-${stageIndex}`,
            safeWriteSteer: true,
            paths,
            responseChars: completion.text.length,
        });
        continue;
    }
    writeError = { message: error.message, name: error.name };
    stageRecords.push({
        error: writeError,
        name: `implement-${stageIndex}`,
        paths,
        responseChars: completion.text.length,
    });
    break;
}
```

Note: `stageIndex > 1` because stage 1 writes to a blank workspace (no conflicts
possible), and SafeWriteError on stage 1 is a genuine error (path escape, symlink
violation, etc.).

### `src/tool-calls.mjs` — `write_file` description

Add one sentence to the write_file tool description:
> "For files that already exist on disk, use `edit_file` instead — `write_file` will
> be rejected if the file exists."

### Tests

In `test/app.test.mjs`, add a suite `runStagedPrompt SafeWriteError steering (Phase 216)`:

1. Stage 2 SafeWriteError → loop continues, `safeWriteSteering` message appears in
   next stage prompt, run does not break with error at stage 2.
2. Stage 1 SafeWriteError → still breaks (path-escape or genuine error on first stage).

Use the existing fake-model-server pattern from other staged tests.

## Done criteria

- [x] `SafeWriteError` (stageIndex > 1) continues stage loop with steering note.
- [x] `safeWriteSteering` injected into next stage prompt and reset after use.
- [x] `SafeWriteError` on stage 1 still breaks (not affected by the change).
- [x] `write_file` description updated.
- [x] 2 new tests pass.
- [x] All existing staged / safe-write tests pass.
- [x] `npm run format && npm run check` clean.
- [x] `process/decisions.jsonl` entry added.
- [x] Blog post exists.
- [x] Roadmap entry marked done.
- [x] Commit made.
