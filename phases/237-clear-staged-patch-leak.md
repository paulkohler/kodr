# Phase 237 — Clear Applied Patches Between Staged Stages (Staged clearFiles Patch Leak)

## Motivation (the patch that wouldn't leave)

This is the **sibling** of phase 235. Phase 235 found the heal loop reusing a
stale `registry.proposalDraft` and fixed it with a full `clear()`. The staged
pipeline has the **same asymmetry, the other half of it**: after a staged
implement stage applies its writes it calls `clearFiles(appliedPaths)`
(`src/run-pipeline.mjs:2195`), which removes only the draft's **file** entries —
`_patches` is left untouched. So an applied `edit_file` patch **leaks** into every
subsequent staged implement stage.

Phase 235 added the full-reset `clear()` (`tool-calls.mjs:179-187`, drops files +
patches + aliasHits) **but only the HEAL path uses it**. The STAGED path still
uses the patches-incomplete `clearFiles`. Phase 235's review explicitly flagged
this gap — `clearFiles` clearing only `_files` is exactly why heal needed a
separate `clear()`. The staged path never got the symmetric fix. This phase closes
that asymmetry for the staged path.

## The bug (root cause — verified by reading the code AND the ambitious-dogfood artifacts)

The staged loop reuses the **same** `registry` (and thus the **same**
`registry.proposalDraft` instance) across every implement stage. Each stage:

1. `completeWithToolCalls(..., registry)` records this stage's `write_file` /
   `edit_file` calls into `registry.proposalDraft` (`run-pipeline.mjs:1926-1932`).
2. `capturedDraft = completion.proposalDraft` is the **same** draft instance
   (`tool-calls.mjs:339` reads `registry?.proposalDraft`); `draftNonEmpty =
   capturedDraft !== null && !capturedDraft.isEmpty` (`run-pipeline.mjs:1961-1962`).
3. `proposal = mergeProposalWithDraft(capturedDraft, proposal)`
   (`run-pipeline.mjs:1965/1968`) folds the draft's `_files` AND `_patches` into
   the proposal. `mergeProposalWithDraft` (`tool-calls.mjs:1210-1213`) **always**
   prepends `capturedPatches` (the draft's `_patches`) to the merged patches.
4. `paths = proposalPaths(proposal)` (`run-pipeline.mjs:2012`) →
   `proposalPaths` (`run-pipeline.mjs:3359-3364`) returns
   `[...proposal.files.map(f=>f.path), ...proposal.patches.map(p=>p.path)]` —
   it surfaces **patch paths too**.
5. After a successful apply, `appliedPaths = writeResult.writes.map(w=>w.path)`
   (`run-pipeline.mjs:2194`, includes BOTH file-writes and patch-applies) and
   `registry?.proposalDraft?.clearFiles(appliedPaths)` (`2195`) deletes only the
   `_files` entries. **The applied patch entry stays in `_patches`.**

Next stage: `capturedDraft.isEmpty` is `false` (because `_patches.length > 0`,
`isEmpty` checks both — `tool-calls.mjs:94-96`), so `draftNonEmpty` is `true`, the
**stale** applied patch is merged again (step 3), and `proposalPaths` re-reports it
(step 4). The stale patch is "live" forever — it can never be cleared, because
`clearFiles` will never touch `_patches`.

### `_patches` entry shape (confirmed — `tool-calls.mjs:129-143`)

`recordPatch` pushes `{ path, search, replace }`, and on a live apply sets
`entry.applied = true` (and `entry.writeRecord`). So every captured patch entry
carries a `.path` (what `clearPatches(paths)` will match on) and an applied patch
carries `applied: true`.

## Live evidence (ambitious dogfood, `final-audit-3/task-api`, run `2026-06-20T11-42-28.168Z`, `summary.json` → `staged.stages`)

- **implement-1**: `proposedPaths=[db.mjs, auth.mjs, server.mjs, api.test.mjs]`,
  `writeCount=4`, `applied=4`. These were `write_file` → `_files`; `clearFiles`
  cleared them — fine.
- **implement-2**: `proposedPaths=["test/api.test.mjs"]`, `writeCount=1`, applied —
  an `edit_file` **PATCH** → `_patches`. `clearFiles` did NOT clear it.
- **implement-3**: `proposedPaths=["test/api.test.mjs"]`, **`writeCount=0`,
  `appliedPaths=[]`**, `done=true` (`STAGED_DONE`). The stale implement-2 patch
  **leaked** into implement-3's `proposedPaths`; `prepareChanges`/`prepareWrites`
  found the patch no longer applied (already applied — search string already
  consumed) → `writeResult.writes.length === 0`.

**No data loss occurred in this run** (the model's `STAGED_DONE` ended it before
the leak could compound). But the defect is real:

- **Misleading stage records.** `proposedPaths` reports paths the stage never
  proposed — every subsequent stage's `proposedPaths` is polluted by the union of
  all prior applied patches.
- **Latent no-progress hazard.** A stage that ONLY re-emits stale patches looks
  like a zero-applied stage to the phase-225 zero-write / phase-224 no-progress
  counters — it can inflate the no-progress count or trigger `implicitDone` for the
  wrong reason.
- **Latent duplicate-application hazard.** If a later stage **legitimately**
  re-patches the same file, `prepareChanges` receives BOTH the stale `applied:true`
  patch AND the new one. The staged path — unlike the main path — does NOT filter
  applied entries before its per-stage `prepareChanges` (the main path does:
  `(proposal.patches || []).filter(p => !p.applied)`, `run-pipeline.mjs:1343`). It
  relies on the between-stage clear to keep the draft fresh, and that clear is
  exactly what is broken for patches.

## The fix

Do **not** repurpose `clearFiles` — its file-only contract is encoded in two
existing tests (phase 217 `test/tool-calls.test.mjs:2393`, phase 235 regression
`test/healing.test.mjs:1590`) and the heal path's `clear()` depends on `clearFiles`
staying files-only. Add patch-clearing **explicitly**, symmetric to `clearFiles`.

### Chosen API: `clearPatches(paths)` companion (NOT a combined `clearApplied`)

**Decision: add `clearPatches(paths)` and call BOTH at the staged site.**

Rationale for `clearPatches` over a combined `clearApplied(paths)`:

- **Symmetry / least surprise.** `ProposalDraft` already exposes `clearFiles(paths)`
  (files-only) and `clear()` (full reset). A path-scoped `clearPatches(paths)` slots
  in as the obvious third member — files-scoped, patches-scoped, all. A combined
  `clearApplied` would be a fourth concept whose semantics ("both, by path") a reader
  must learn; the two primitives composed at the call site are self-documenting.
- **No hidden coupling.** The staged site already calls `clearFiles(appliedPaths)`;
  adding `clearPatches(appliedPaths)` on the next line keeps the two clears visible
  and independently testable. A combined method hides one behind the other.
- **Minimal blast radius.** One new method, one added line at `2195`. No existing
  call site changes behavior.

(A combined `clearApplied(paths)` that does both is a defensible alternative — it
guarantees the two are never accidentally separated. Rejected only on the symmetry
and visibility grounds above; this is a low-stakes naming choice, noted here for the
implementer.)

### 1. Add `clearPatches(paths)` to `ProposalDraft` (`src/tool-calls.mjs`, after `clearFiles` ~line 177, before `clear()` ~179)

```js
// Phase 237: remove patch entries for already-applied paths, symmetric to
// clearFiles. The staged pipeline applies a stage's writes then clears the draft
// so the next stage starts clean; clearFiles removes only _files, so an applied
// edit_file patch would otherwise leak into every subsequent staged stage
// (re-surfacing in proposalPaths and re-merging via mergeProposalWithDraft). This
// drops every captured patch whose .path is in `paths`. clearFiles stays
// files-only (phase 217/235 contract); clear() (phase 235, heal) is unchanged.
clearPatches(paths) {
	const drop = new Set(paths);
	this._patches = this._patches.filter((patch) => !drop.has(patch.path));
}
```

Note: `_patches` is reassigned (filter returns a new array). The `patches` getter
returns `[...this._patches]` so external snapshots are unaffected, and `clear()`
sets `this._patches.length = 0` on whatever array is current — reassigning here does
not break `clear()`. (If the implementer prefers to mutate in place to mirror
`clear()`'s `length = 0` style, an index-walk splice is equivalent; the filter form
is clearer and `_patches` is never aliased elsewhere — verify with a grep for
`._patches` before choosing.)

### 2. Clear applied patches at the staged apply site (`src/run-pipeline.mjs:2191-2196`)

```js
allWrites.push(...writeResult.writes);
// Clear applied file paths from the shared draft so read_file in the next
// stage reads from disk rather than returning stale pending-write labels.
const appliedPaths = writeResult.writes.map((w) => w.path);
registry?.proposalDraft?.clearFiles(appliedPaths);
// Phase 237: also drop applied PATCH entries. clearFiles removes only _files;
// without this, an applied edit_file patch leaks into every subsequent staged
// stage (re-surfacing in proposalPaths, re-merged by mergeProposalWithDraft).
// appliedPaths covers both file-writes and patch-applies, so the same path set
// clears both accumulators.
registry?.proposalDraft?.clearPatches(appliedPaths);
```

Nothing else in the staged loop changes. `noProgressTurns = 0`, the
`safeWriteSteered` reset, the `stagedDoneSignal` honoring, and the stage record push
are byte-identical.

### Why clearing applied patches here is SAFE (verified)

- The patches are **already applied** — they were pushed into `allWrites` on the
  line above (`2191`), so the run summary and end-of-run accounting already hold
  them. Clearing the draft entry loses nothing the run needs.
- The stage is **done consuming** the draft by this point: the proposal was built
  (`1965/1968`), `paths`/`uniquePaths` computed (`2012-2013`), `prepareChanges` ran
  (`2073`). The clear happens AFTER all of that.
- Nothing downstream reads the stale entry. The staged path never re-reads the draft
  for the *current* stage after `2195`; the NEXT stage *should* start clean (that is
  the whole point). The end-of-staged-run accounting uses `allWrites` /
  `stageRecords`, not the live draft patches.

## Edge cases & regression guards

- **Phase 217 / 235 `clearFiles` files-only tests stay GREEN.** `clearFiles` is
  unchanged; `test/tool-calls.test.mjs:2393` (phase 217) and
  `test/healing.test.mjs:1590` (phase 235 — "clearFiles still removes only files,
  leaves patches") are untouched and must remain green. `clearPatches` is a separate
  method.
- **Heal `clear()` unchanged.** The heal path uses `clear()` (`run-pipeline.mjs:2609`),
  not `clearFiles`/`clearPatches`. Phase 235's full-reset-at-heal-turn-start is
  byte-identical. `clear()`'s body is not modified.
- **Main non-staged path unaffected.** The main path does NOT call `clearFiles` at
  all (phase 235 documented this — it relies on heal-turn `clear()` and end-of-run
  `filter(p => !p.applied)` at `1343`). It also does not call `clearPatches`. Zero
  change to the main pipeline.
- **File-write + patch to the SAME path in one stage.** `appliedPaths` lists that
  path once per write record; `clearFiles(appliedPaths)` removes the `_files` entry
  and `clearPatches(appliedPaths)` removes every `_patches` entry whose `.path`
  matches. Both cleared. (Test.)
- **Multiple patches to the same path.** `clearPatches` uses a path-membership
  filter, so **all** `_patches` entries with a matching path are removed, not just
  the first. (Test.)
- **`mergeProposalWithDraft` (W3/W4) unaffected.** It reads `draft.patches` at merge
  time; clearing applied patches before the next stage merely means the next stage's
  draft holds only that stage's own patches. The merge logic
  (`tool-calls.mjs:1210-1213`) is unchanged.
- **Phase 226 duplicate-block guard unaffected.** The duplicate-block detection
  (`tool-calls.mjs:1087-1094`) is a patch-application failure reason inside
  `prepareChanges`; clearing the *draft* after a successful apply does not touch it.
- **Phase 224/225 zero-write / no-progress logic unaffected, and improved.** The
  zero-applied-write branch (`run-pipeline.mjs:2147`) and the no-progress counter
  (`2160-2196`) key on `writeResult.writes.length` and `noProgressTurns`. Clearing
  stale patches does not change those counters — it removes the spurious input
  (a stale patch re-surfacing as a zero-applied "proposal") that could mislead them.
  The auto-advance / `implicitDone` paths are unchanged.
- **`proposalPaths` now returns only live patches in the next stage.** After the
  fix, the NEXT stage's draft holds only that stage's own patches, so
  `proposedPaths` in the stage record is accurate (no leaked prior-stage patches).

## Tests

### Unit — `test/tool-calls.test.mjs` (alongside the phase-217 `clearFiles` block ~2393)

- [x] **`clearPatches` removes only matching-path patch entries, leaves others** —
  `recordPatch('src/a.mjs', …)`, `recordPatch('src/b.mjs', …)`,
  `clearPatches(['src/a.mjs'])` → `patches.length === 1` and the remaining entry is
  `src/b.mjs`.
- [x] **`clearPatches` removes ALL patches for the same path** —
  `recordPatch('src/a.mjs', 's1', 'r1')`, `recordPatch('src/a.mjs', 's2', 'r2')`,
  `clearPatches(['src/a.mjs'])` → `patches.length === 0`.
- [x] **`clearPatches` leaves `_files` untouched** — `recordFile('src/a.mjs', …)`,
  `recordPatch('src/a.mjs', …)`, `clearPatches(['src/a.mjs'])` → `patches.length === 0`,
  `files.length === 1` (symmetry mirror of the phase-235 `clearFiles` files-only test).
- [x] **`clearPatches([])` is a no-op** — patches survive.
- [x] **Regression preserved: `clearFiles` still files-only** — assert (or rely on
  the existing phase-217/235 tests) that `clearFiles` does not remove patches. (The
  existing tests already cover this; do not duplicate, just confirm they pass.)
- [x] **Combined clear at the staged site removes both (unit proof of the call-site
  contract)** — `recordFile('src/a.mjs', …)`, `recordPatch('src/a.mjs', …)`, then
  `clearFiles(['src/a.mjs'])` + `clearPatches(['src/a.mjs'])` → `isEmpty === true`.
- [x] **Stale applied patch does not survive into the next stage's `proposalPaths`
  (mechanism proof)** — the cleanest seam without standing up a full staged run:
  record a patch (mark applied), apply the combined clear with its path, then build a
  fresh proposal via `mergeProposalWithDraft(draft, null)` and assert the synthesized
  proposal's `patches` is empty (or, equivalently, that `draft.patches` is empty so
  `proposalPaths` of the next merge yields `[]`). This is the unit-level analogue of
  the dogfood implement-3 leak.

### End-to-end — `test/app.test.mjs` (only if a clean seam exists)

An end-to-end staged multi-stage scenario (stage-2 applies a patch, stage-3 must NOT
re-report it) is the ideal proof but may be awkward to stage through
`startFakeModelServer` (it requires a real `edit_file` apply whose `search` matches
seeded disk content, then a third stage that proposes nothing). The existing staged
harness around `test/app.test.mjs:8046` ("Stage 2: clearFiles (Phase 217) clears the
draft after stage 1 applies") is the closest precedent — if it can be extended to seed
a file, have stage-1 `edit_file` it, and assert stage-2's `proposedPaths` does NOT
include that path, do so. **If the fake-server harness cannot cleanly stage this**,
the focused unit tests above (especially the "stale applied patch does not survive"
mechanism proof) are an acceptable substitute — note this in the test file exactly as
phase 235 noted it for its case (d) ("if the harness cannot cleanly stage a two-stage
patch sequence, the unit proof covers the same mechanism: between-stage `clearPatches`
makes the leak impossible").

### Confirm unchanged

- [x] The existing staged `clearFiles` test (`test/app.test.mjs:8046`) passes
  unchanged.
- [x] Phase 217 `clearFiles` block (`test/tool-calls.test.mjs:2393`) and phase 235
  `clear()` block (`test/healing.test.mjs:1564`) pass unchanged.
- [x] The phase 224/225/226/233 staged tests in `test/app.test.mjs` pass unchanged.

## Work items (Required Loop)

- [x] Add `ProposalDraft.clearPatches(paths)` to `src/tool-calls.mjs` (after
  `clearFiles` ~177, before `clear()` ~179). `clearFiles` and `clear()` unchanged.
- [x] Call `registry?.proposalDraft?.clearPatches(appliedPaths)` immediately after
  the existing `clearFiles(appliedPaths)` at `src/run-pipeline.mjs:2195`. Rest of the
  staged loop byte-identical.
- [x] Unit tests on `clearPatches` in `test/tool-calls.test.mjs` (alongside the
  phase-217 `clearFiles` block); end-to-end staged test in `test/app.test.mjs` if a
  clean seam exists, otherwise the unit mechanism proof with a note (per phase 235's
  case-(d) precedent). Confirm the existing staged/clearFiles/clear tests pass
  unchanged.
- [x] `npm run format` (globally-installed Biome; do not add it as a dependency).
- [x] Run tests (`node --test` / `npm test`).
- [x] `npm run check` — requires `package.json` version == max roadmap phase, so bump
  `0.0.236` → `0.0.237` first.
- [x] `process/decisions.jsonl`: record the `clearPatches` decision — the staged
  pipeline clears applied patches between stages via a new
  `ProposalDraft.clearPatches(paths)` (symmetric to `clearFiles`), called alongside
  `clearFiles(appliedPaths)` at `run-pipeline.mjs:2195`. Note it **completes the
  phase-235 `clearFiles`/`clear()` asymmetry for the staged path**: phase 235 added
  the full-reset `clear()` for the HEAL path; the STAGED path still used the
  patches-incomplete `clearFiles`, so applied `edit_file` patches leaked across
  stages. Why `clearPatches` over a combined `clearApplied` (symmetry, call-site
  visibility, minimal blast radius). Why clearing applied patches is safe (already in
  `allWrites`; stage done consuming the draft; next stage must start clean).
  Cross-reference phases 217 / 235.
- [x] `process/failures.jsonl`: record the ambitious-dogfood finding —
  `final-audit-3/task-api`, run `2026-06-20T11-42-28.168Z`: staged `clearFiles`
  leaked an applied `edit_file` patch (implement-2 PATCH → implement-3
  `proposedPaths` re-reported it with `writeCount=0`). Root cause verified from
  `summary.json` `staged.stages`: `clearFiles` clears only `_files`, the **SAME
  asymmetry the phase-235 review flagged** for the heal path, now found in the staged
  path. No data loss in the observed run (`STAGED_DONE` ended it) but latent
  duplicate-application / no-progress hazards. Fix: `clearPatches` at the staged site.
  Cross-ref phase 235; do not duplicate phase 235's heal-carryover symptom text.
- [x] `blog/237-clear-staged-patch-leak.md`: theme "The patch that wouldn't leave" —
  `clearFiles` clears files but not patches, the implement-2 → implement-3 leak in the
  dogfood `summary.json`, why this is the staged half of the phase-235 asymmetry, and
  why a symmetric `clearPatches` (not a `clearFiles` repurpose that would break the
  files-only contract) is the right seam.
- [x] `roadmap.md`: append
  `- [x] 237 Clear Applied Patches Between Staged Stages (Staged clearFiles Patch Leak)`.
- [x] `package.json`: bump `0.0.236` → `0.0.237`.
- [x] `NEXT.md`: update "Current frontier" to phase 237 (note phase 237 closed the
  staged `clearFiles` patch leak — the staged half of the phase-235 draft-carryover
  asymmetry). **Nothing to delete** — this was found in the final audit, not queued as
  a NEXT candidate.
- [x] Commit (small, single phase).

## Must NOT change (regression guard)

- `clearFiles` (`src/tool-calls.mjs:173-177`) — files-only semantics retained; phase
  217 (`test/tool-calls.test.mjs:2393`) and phase 235
  (`test/healing.test.mjs:1590`) tests must stay green.
- `clear()` (`src/tool-calls.mjs:179-187`) — the phase-235 full reset is unchanged;
  the heal-turn `clear()` at `run-pipeline.mjs:2609` is unchanged.
- The main non-staged path — never called `clearFiles`/`clearPatches`; unchanged.
- `mergeProposalWithDraft` (`src/tool-calls.mjs:1158-1236`) and `proposalPaths`
  (`src/run-pipeline.mjs:3359-3364`) — unchanged; the fix removes the stale input,
  not the consumers.
- The phase 224/225/226/233 staged branches in `runStagedPrompt` — byte-identical;
  only one `clearPatches` line is added after the existing `clearFiles` at `2195`.
- The existing staged `clearFiles` app-test (`test/app.test.mjs:8046`) — must pass
  unchanged.
