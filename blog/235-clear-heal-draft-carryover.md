# Phase 235: The Heal That Re-Wrote What Was Already There

The phase-234 dogfood (`phase-234/cap-wiring-1`) ended with a working cap
and a sibling bug: a heal turn that ran away on reasoning was classified
`no-progress-exhausted` instead of `reasoning_runaway`. Phase 231's accurate
label was being suppressed. The question was why.

## The empty-diff / real-hash tell

The artifact that explained it was `repairs/turn-1/writes.json`. The heal turn
had produced a proposal — a non-empty one, with three files:

```json
{ "path": "src/counter.js", "status": "modify",
  "diff": "--- src/counter.js\n+++ src/counter.js\n",
  "hash": "97b6dc73…" }
```

Empty diff. Real content hash. The proposed content was byte-identical to what
was already on disk. These were no-op writes.

The model had NOT called `write_file` during the heal turn. It called `read_file`
twice, then reasoned itself to `finish_reason: length` with zero answer tokens. No
files were written. Yet the proposal contained three files.

Where did they come from?

## The stale draft

The answer is in the `ProposalDraft` lifetime. The registry is created once at
run start. The main run calls `write_file` for three files — those are recorded
into `registry.proposalDraft`. The main pipeline then reads the draft (aliasHits
at ~1172, proposalChannels at ~1176, buildLiveWriteRecords at ~1357), builds the
proposal, and applies the writes. The files land on disk.

But the draft is never cleared on the non-staged path. Only the staged path has
a `registry?.proposalDraft?.clearFiles(appliedPaths)` call at ~2195, and that runs
only inside `runStagedPrompt`.

The same `registry` — same `ProposalDraft` instance, still holding the three
already-written files — flows into `runHealingIfNeeded` and then into the
`repairTurn` callback. The callback reads `completion.proposalDraft` (which is
`registry.proposalDraft`, the same object), finds `draftNonEmpty` true, and calls
`mergeProposalWithDraft(capturedDraft, null)` — re-emitting the main run's files
as the heal turn's proposal.

The phase-234 failures entry called these "empty-content file entries" and suggested
diagnosing "where the 3 empty-content entries originate / repair-context failurePaths".
That was the wrong lead. The diff is empty; the content is not. These are
full-content stale carryovers — the main run's real files, re-emitted unchanged.

## Why this defeats phase-231

Phase 231's `isReasoningRunaway` is deliberately gated on `proposalNonEmpty`:

```js
// src/healing.mjs:154
if (proposalNonEmpty) return false;
```

The reasoning: if the model expressed repairs via `write_file`, the empty text is
normal (native channel returns no text) and the turn is not a runaway. So a
non-empty proposal short-circuits the runaway check.

The stale carryover makes `proposalNonEmpty` true on a turn where the model wrote
nothing at all. Phase 231's predicate is doing exactly what it was scoped to do.
The bug is upstream: the draft should have been empty going into the heal turn.

## The fix

Two changes, in sequence:

**1. `ProposalDraft.clear()`** — added to `src/tool-calls.mjs` after `clearFiles`.
Resets all three accumulators: `_files.clear()`, `_patches.length = 0`,
`_aliasHits.clear()`. `clearFiles` is unchanged — the staged path depends on its
file-only semantics.

**2. `registry.proposalDraft?.clear()` at the top of `repairTurn`** — in
`src/run-pipeline.mjs`, gated on `options.tools && registry`. Runs before the
`completeWithToolCalls` call, so each heal turn starts with a clean capture surface.

The clear happens at turn-start, not in the main path after apply. That placement
is important for two reasons:

- The main path reads the draft after apply (aliasHits, proposalChannels,
  buildLiveWriteRecords). Clearing there would zero out live-write records and
  W5 forensics. The heal callback runs strictly after those reads.
- Turn-start clearing covers both carryover modes: main run → heal turn-1, and
  heal turn-1 → heal turn-2. A "clear once before the loop" alternative would
  only fix the first.

The turn's own writes survive because `clear()` runs before the model call.
Any `write_file` the model issues during the heal turn lands in the freshly-emptied
draft and is captured normally.

## What changes for real runs

After the fix, a heal turn where the model only reads files (or runs away) has an
empty draft. `draftNonEmpty` is false. The `repairTurn` callback returns
`{ raw, text }` with no `proposal` key. In `runSelfHealingLoop`,
`turnProposalNonEmpty` is false. If the turn also has `finish_reason: length` and
empty text, `isReasoningRunaway` fires — `reasoning_runaway` stop reason, one turn,
`runaway.json` written for forensics.

The phase-234 runaway would have been correctly classified immediately. The two
no-op `modify` writes with empty diffs would never have appeared.

## Tests: 1871 → 1878

Seven new tests across two files:

**`test/healing.test.mjs`** — `describe('ProposalDraft.clear() (phase 235)')`:
- `clear()` empties files, patches, AND alias hits; `isEmpty` is true afterward.
- `clearFiles` regression: still removes only files, leaves patches (staged invariant).
- Inter-turn carryover: `clear()` followed by `recordFile` captures only the new write.

**`test/app.test.mjs`** — `describe('Phase 235 — heal draft carryover')`:
- (a) Stale main-run write NOT re-emitted in heal turn proposal.
- (b) Runaway heal turn classifies `reasoning_runaway` after draft cleared.
- (c) Legitimate heal write is preserved after draft cleared at turn-start.
- (d) Inter-turn carryover documented: same mechanism as (a), unit-level coverage.

Tests (a) through (c) use the native model profile (`writeNativeProfile`) with
`--tools` and `--yes`, staging a `write_file` main run followed by a broken-syntax
test command that triggers heal. Each asserts against the `repairs/turn-1/`
artifacts written by `runSelfHealingLoop`.
