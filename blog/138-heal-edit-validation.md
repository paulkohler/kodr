# Phase 138: Tell the Model While It Can Still Act

Phase 136 gave the heal loop room. Eight inner turns instead of four. Enough to
read the file, issue repairs, check the result, and react.

And yet the re-validation artifacts from phase 135 showed three wasted turns.

The model did read the file. It saw the current state — the edits that outer turn
1 had already applied. Then it issued five `edit_file` calls. Two succeeded. Three
failed with `no_match`. Not because the model misread the file, but because it
planned all five edits before submitting any of them, and three of those plans
referenced lines that outer turn 1 had already changed.

The harness knew immediately. `preparePatches` found those three search strings
missing. It computed the closest matching region and attached it to the error.
All of that information was correct and useful.

It arrived one full outer turn too late.

## The gap

In live mode, `edit_file` calls `preparePatches` immediately, on the real disk
file. The patch is applied, the disk changes, and if the search text isn't there,
the model gets the region hint on the very next message — while it still has
turns to react.

In proposal mode, `edit_file` just calls `proposalDraft.recordPatch`. No
validation. No signal. All five edits are silently recorded, the inner tool loop
finishes, and only then does `prepareChanges` run and discover the failures.
The model's next chance to act is the next outer heal turn.

The feature is the same between modes — the model should get the same signal.
Proposal mode was missing the "while it can still act" part.

## The fix

An `editAccum` map in the tool registry, initialized per tool-call session.

When `edit_file` is called in proposal mode:

1. If this path hasn't been seen yet, read it from disk.
2. Validate the search text against the accumulated content — disk state, updated
   by every accepted edit so far in this session.
3. If the search text isn't there: return the same error the live mode would
   return, with the same region hint. The patch is **not** recorded.
4. If the search text is found exactly once: update the accumulator with the
   replacement applied, then record the patch.

The model now sees stale-hunk failures within the same inner loop turn, not
after it ends. It can pivot, call `read_file`, and issue a corrected edit —
all without spending an outer heal turn on the round-trip.

## What didn't change

`proposalDraft` is unchanged. The accumulator runs in parallel, purely for
validation; it doesn't change what gets recorded or how `prepareChanges`
applies the draft at the end. Nothing in live mode touched.

Files with no disk state (new paths the model is creating) still fall through
to `proposalDraft.recordPatch` — the accumulator holds `null` and validation
is skipped. `prepareChanges` handles `missing_target` exactly as before.

## What it doesn't fix

If the model ignores the per-edit feedback and keeps issuing stale searches
anyway, more budget still helps. The 135/136/138 arc together — right channel,
enough room, immediate feedback — gives the model the best available shot at
convergence. Whether it converges depends on the model. This is the harness
half. The harness half is now done.
