# Phase 216: Staged Pipeline SafeWriteError Steering

## The failure that prompted this phase

Phase 215 fixed `ProposalMissingError` in the staged pipeline by adding a W3 draft
fallback. The dogfooding run that triggered Phase 215 had a second failure mode that
wasn't visible until the first was fixed.

After the draft fallback landed, a follow-up staged run got further — stage 1 wrote
five files cleanly — then hit a wall at stage 2. The model correctly identified a bug
in the stage 1 output and produced full fixed rewrites. The harness rejected all five
with `SafeWriteError`:

```
Refusing to overwrite existing file via files[]: src/server.mjs — use patches[] instead
```

The catch block at `runStagedPrompt` treated all `prepareChanges` errors as fatal. It
set `writeError`, pushed a stage record with the error, and `break`ed the loop.

The run ended `ok:false`. All five corrected files were ready. They were never applied.

## Why stage 2 is different from stage 1

Stage 1 runs against a blank workspace. If `SafeWriteError` fires at stage 1, it
means the model tried to write outside the jail, or a symlink crossed a boundary — a
genuine security violation. Break is correct.

Stage 2 and beyond run against a workspace that stage 1 has already populated.
`SafeWriteError` at stage 2 almost always means the model used `files[]` to replace a
file it should have patched with `patches[]`. The model often does this when it finds
a bug in its own earlier output: it produces a full corrected rewrite, which the
`files[]` key is designed for, not noticing that the file already exists.

The error is recoverable. The model already has the correct content — it just used the
wrong delivery mechanism. The right response is to steer it toward `edit_file` or
`patches[]` for the next stage.

## The fix

In the `prepareChanges` catch block inside `runStagedPrompt`, intercept `SafeWriteError`
when `stageIndex > 1`:

```js
if (stageIndex > 1 && error instanceof SafeWriteError) {
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
```

The `conflicts` list is built by `access()`-checking each `files[]` entry against
the workspace. If all paths are found, the message names them specifically. If none
are found (edge case: `SafeWriteError` from a different cause), the error message
itself is included as context.

The steering message is stored in `safeWriteSteering` and injected into the next
stage's prompt as a `## Harness note` section:

```js
safeWriteSteering ? `\n## Harness note\n${safeWriteSteering}` : '',
```

It resets to `null` immediately after the prompt is built, so the note appears for
exactly one stage.

## The companion nudge in the write_file description

The steering note fires after the fact. To prevent the problem upstream, a sentence
was added to the `write_file` tool description:

> For files that already exist on disk, use `edit_file` instead — `write_file` will
> be rejected if the file exists.

This is present in both the live and proposal variants of the description. Models
reading the tool schema see this constraint before they choose `write_file` for a
rewrite, reducing the frequency of the error the steering is designed to recover from.

## What the stageRecord captures

When `SafeWriteError` is intercepted at stage N > 1, the stage record carries
`safeWriteSteer: true` instead of `error:`. This distinguishes recoverable steering
events from fatal errors in the `summary.staged.stages` array — tooling can report
them without treating the run as broken.

## Pattern in the staged pipeline evolution

Phases 213, 215, and 216 form a sequence:

- Phase 213: `run_command` guard blocks tests against pending writes.
- Phase 215: W3 draft fallback synthesises a proposal when the tool channel has
  files but the text channel has no envelope.
- Phase 216: `SafeWriteError` at stage N > 1 steers the next stage instead of
  aborting.

Each phase fixed a specific point where the staged pipeline fell off the happy path.
The staged runs are getting longer before failing — which means each fix is working
and exposing the next bottleneck.
