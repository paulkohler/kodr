# Phase 237: The Patch That Wouldn't Leave

Phase 235 found the heal loop reusing a stale `registry.proposalDraft` and fixed
it with a full `clear()`. The story seemed closed. It wasn't. The staged pipeline
had the same asymmetry — and it took an ambitious dogfood run to surface it.

## The artifact that told the story

The run was `final-audit-3/task-api`, timestamp `2026-06-20T11-42-28.168Z`. The
`summary.json` `staged.stages` section showed three implement stages:

- **implement-1**: `proposedPaths=[db.mjs, auth.mjs, server.mjs, api.test.mjs]`,
  `writeCount=4`, four `write_file` calls applied and cleared. Fine.
- **implement-2**: `proposedPaths=["test/api.test.mjs"]`, `writeCount=1`. An
  `edit_file` patch — the model had a specific change to apply.
- **implement-3**: `proposedPaths=["test/api.test.mjs"]`, **`writeCount=0`**,
  `done=true` (`STAGED_DONE`). The model signaled it was finished, but the stage
  had already re-reported a path it never proposed.

Implement-3 did not propose a patch. The staged loop re-surfaced implement-2's
patch as implement-3's `proposedPaths`, then handed it to `prepareChanges`, which
found the search string already consumed (implement-2 had applied it), returned zero
writes, and the stage completed with `writeCount=0`.

No data loss in this run — `STAGED_DONE` ended it before the leak could compound.
But the defect was real, and reproducible by reading the code.

## The asymmetry

The staged pipeline calls `clearFiles(appliedPaths)` at `run-pipeline.mjs:2195`
after each successful apply. `clearFiles` deletes entries from `_files` — the
Map that holds `write_file` captures. It does not touch `_patches` — the Array
that holds `edit_file` captures.

Phase 235 documented this precisely. It found that `clearFiles` was files-only by
design (the staged path depended on that contract), and added a separate `clear()`
for the heal path that reset all three accumulators. The phase-235 review explicitly
named the gap: the staged path still relied on a clear that couldn't touch patches.

The staged path uses the same `registry` — same `ProposalDraft` instance — across
every implement stage. Stage 2 applied an `edit_file` patch and called
`clearFiles(appliedPaths)`. The patch entry stayed in `_patches`. Stage 3's
`mergeProposalWithDraft` prepended those `capturedPatches` into the merged proposal.
`proposalPaths` surfaces both `proposal.files.map(f=>f.path)` and
`proposal.patches.map(p=>p.path)` — so the stale patch entry re-entered as a
proposed path for stage 3.

The main non-staged path does not have this bug. It filters `!p.applied` at
`run-pipeline.mjs:1343` before `prepareChanges` — applied patches are excluded
before they can be replayed. The staged path had no such filter; it relied
entirely on the between-stage clear.

## The fix

Do not repurpose `clearFiles`. Its files-only contract is encoded in tests and
relied on by the heal path. Add a symmetric `clearPatches(paths)` alongside it:

```js
// src/tool-calls.mjs, after clearFiles, before clear()
clearPatches(paths) {
    const drop = new Set(paths);
    this._patches = this._patches.filter((patch) => !drop.has(patch.path));
}
```

Then at the staged apply site, call both:

```js
// src/run-pipeline.mjs:2195
registry?.proposalDraft?.clearFiles(appliedPaths);
registry?.proposalDraft?.clearPatches(appliedPaths);
```

`_patches` is reassigned (filter returns a new array). `clear()`'s
`this._patches.length = 0` operates on whatever `_patches` currently is — the
reassignment is safe because `_patches` is never aliased outside the class. The
same `appliedPaths` set covers both file-writes and patch-applies, so one path set
clears both accumulators.

## Why `clearPatches` and not a combined method

`ProposalDraft` now exposes three clear methods: `clearFiles(paths)` (files only),
`clearPatches(paths)` (patches only), and `clear()` (full reset). A combined
`clearApplied(paths)` that does both was considered and rejected on two grounds:

- **Call-site visibility.** Two explicit adjacent lines are self-documenting. A
  combined method hides one clear behind the other, and the asymmetry becomes
  invisible again — exactly the kind of implicit coupling that let this bug persist
  through phase 235's review.
- **Minimal blast radius.** One new method, one added line. No existing call site
  changes behavior. The phase-217 and phase-235 clearFiles tests are unchanged and
  still green; the heal-turn `clear()` is byte-identical.

## What changes for real runs

After the fix, the next staged implement stage after a successful `edit_file` apply
starts with an empty `_patches`. `proposalPaths` reports only what that stage
actually proposed. The no-progress counters key on `writeResult.writes.length`, so
clearing stale patches does not affect them — it removes the spurious input (a
zero-write replay of a stale patch) that could mislead them.

The stage records become accurate: `proposedPaths` in the record reflects only the
paths the stage genuinely proposed, not the union of all prior applied patches.

## Tests: 1882 → 1889

Seven new unit tests in `test/tool-calls.test.mjs` in a `describe('ProposalDraft.clearPatches')` block after the phase-217 `clearFiles` block:

- `clearPatches` removes only matching-path entries, leaves others.
- `clearPatches` removes ALL patches for the same path (multiple patches, one path).
- `clearPatches` leaves `_files` untouched (symmetry mirror of phase-235 clearFiles
  files-only test).
- `clearPatches([])` is a no-op.
- `clearFiles` regression: still removes only files, leaves patches (phase 217/235
  contract confirmed inline).
- Combined `clearFiles+clearPatches` at the staged site yields `isEmpty === true`.
- Mechanism proof: an applied patch (marked `applied:true`) does not survive into
  the next stage after the combined clear. The unit tests exercise the exact same
  invariant as the dogfood implement-2 → implement-3 leak: `clearFiles` alone leaves
  the patch in `_patches`; `clearPatches` removes it; `isEmpty` is true afterward.
  A full end-to-end staged two-stage patch sequence through `startFakeModelServer`
  was not staged because the fake-server harness requires seeding disk content that
  `edit_file` can match — the unit mechanism proof covers the same invariant (per
  the phase-235 case-(d) precedent).

## Dogfood: a found-then-fixed loop, and an honest non-trigger

This bug was *found* by the ambitious audit dogfood (`final-audit-3/task-api`):
implement-2 applied an `edit_file` patch to `test/api.test.mjs`; implement-3 then
re-reported that path with `writeCount: 0` — the stale `_patches` entry leaking
into the next stage. The post-fix re-validation (`phase-237/patch-leak-*`) re-ran
the same task twice but was an **honest non-trigger**: qwen3.6 happened to write
every file via `write_file` (all `status: "create"`), so `_patches` stayed empty
and `clearPatches` had nothing to remove. Worth recording is the *false*
resemblance the operator correctly ruled out — implement-2/3 again showed
`writeCount: 0` on already-applied paths, but that was the model **actively
re-proposing** via fresh `write_file` calls (blocked by `safeWriteSteer`), a
different mechanism from the passive patch carryover (verified against `writes.json`
and the conversation messages). Live reproduction of the patch leak is
model-nondeterministic; the unit mechanism test is its reliable proof, and the
call-site wiring is confirmed by inspection at `run-pipeline.mjs:2195-2201`.
