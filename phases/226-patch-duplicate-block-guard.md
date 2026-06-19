# Phase 226 — Prevent edit_file Patches From Duplicating an Existing Block

## Goal

Close the phase-223 run-3 correctness bug: a multi-write stage applied `edit_file`
patches that left `src/server.mjs` with a duplicate `export let server;` and the
whole guarded-listen block, so every one of the 22 tests failed with
`SyntaxError: Identifier 'server' has already been declared.` The harness wrote
provably-broken code to disk and reported the stage applied.

Add a deterministic guard in `src/safe-writes.mjs preparePatches` that rejects a
patch when applying it would leave a **multi-line block present verbatim more
than once** in the file. Route it to `failedPatches` with a new
`reason: 'duplicate_block'` instead of writing the duplicate, and give the
`edit_file` live handler actionable steering. Pure data-layer fix,
model-independent, fully provable against scripted patches with no live model.

## Why this is next

It is a real, confirmed correctness bug (`process/failures.jsonl`
`223-run3-multi-write-collision`: broken on-disk output, 22/22 tests failing) —
not a quality nudge. The mechanical staged-loop work (224/225) is done and
dogfood-confirmed, so the "synthetic user turn" candidate is now lower urgency
(and is an unverifiable model-behaviour gamble). This is the only remaining
candidate that is simultaneously a confirmed bug, single-phase, deterministically
unit-testable, and low-risk. The syntax gate (`node --check`) already *detects*
the duplicate post-apply and feeds it to healing — but only after writing garbage
to disk and burning a heal turn (the 225-dogfood heal turn timed out at 240s).
Preventing the bad write is strictly better.

### Confirmed mechanism (and why we do NOT use the broad `replace ⊇ search` heuristic)

`failures.jsonl` `223-run3-multi-write-collision`: "Stage 2 applied `edit_file`
patches that appended a second copy of the listen guard to a server.mjs that
already contained it from stage 1." The mechanism is **two patches / cross-stage
duplication of a verbatim block**, not a single self-wrapping patch.

A broad guard ("reject when `replace` contains the entire `search`") was
considered and **rejected**: legitimate wrapping edits have exactly that shape
(`search: 'foo()'` → `replace: 'try { foo() } catch {}'`, or indenting a block
inside a new `if`). Rejecting all of those would break normal `edit_file` usage.
We instead guard the *observable bad outcome* — a non-trivial block ending up in
the file twice — which is precise, matches the confirmed forensic, and does not
penalise wrapping. (Recorded in `decisions.jsonl`.)

### Current behavior that lets the duplicate land (pinned)

`src/safe-writes.mjs preparePatches` processes patches sequentially against
`target.content` (updated after each apply). For each patch it computes
`occurrences = countOccurrences(target.content, normalized.search)` and rejects
only when `occurrences !== 1`. When `occurrences === 1` it does
`target.content.replace(normalized.search, normalized.replace)` and applies it —
**with no check on what the replacement adds.** If stage 1 already wrote the
listen-guard block and stage 2's patch `replace` re-emits that same block at a
different anchor, `occurrences === 1` (the anchor matches once), the patch
applies, and the block now appears twice. `prepareChanges` propagates
`failedPatches` unchanged, so a new reason needs no signature change.

## Changes

### 1. `src/safe-writes.mjs` — `preparePatches` duplicate-block guard

After a patch computes its post-apply content `after` and **before** committing
`target.content = after`, add:

```js
// Phase 226: if applying this patch would leave a multi-line block present
// verbatim more than once, it duplicates a construct (phase-223 run-3: a second
// `export let server;` block -> "Identifier already declared"). Reject instead
// of writing the duplicate. Gated to multi-line blocks (>= 2 non-blank lines) so
// legitimate single-token edits that repeat a literal are never rejected.
const replaceBlock = normalized.replace;
if (isMultiLineBlock(replaceBlock) && countOccurrences(after, replaceBlock) > 1) {
    failedPatches.push({
        path: patch.path,
        reason: 'duplicate_block',
        search: patch.search,
        occurrences,
        region: '',
    });
    continue;
}
```

Add a small local helper:

```js
function isMultiLineBlock(value) {
    return value.split('\n').filter((line) => line.trim() !== '').length >= 2;
}
```

Mechanism / edge cases:
- `countOccurrences(after, replaceBlock) > 1` (not `>= 1`): the block *should*
  appear once — this patch just inserted it. Rejecting only on a **second**
  occurrence catches the duplication without rejecting a normal single insertion.
- `isMultiLineBlock` (>= 2 non-blank lines) keeps single-line edits that repeat a
  common literal (`}`, an import line) from ever tripping the guard. The phase-223
  construct (the multi-line guarded-listen block) is caught; benign edits are not.
- The patch is **collected, not thrown** (consistent with the existing
  `failedPatches` contract) and `target.content` is not mutated, so a later valid
  patch to the same file still composes correctly.
- Compares `normalized.replace` (post-`normalizePatch`) for consistency with how
  the match was found.

### 2. `src/tool-calls.mjs` — `edit_file` live handler steering label

Extend the `reasonLabel` ladder (which currently maps `no_match` /
`multiple_matches`, else falls through to the raw reason) so `duplicate_block`
gets actionable wording:

```js
fp.reason === 'duplicate_block'
    ? 'the replacement block already exists in the file — applying it would create a duplicate; edit the existing occurrence or use write_file for the full file'
    : fp.reason
```

(Only the live-mode handler needs this; proposal/staged mode hits the same
`preparePatches` guard via `prepareChanges`.)

### 3. No change to loop control / apply semantics

`prepareChanges`/`runStagedPrompt` are unchanged. A stage whose only change is a
rejected duplicate patch becomes `writeResult.writes.length === 0` — already
handled by the phase-225 zero-applied-write arm (no-progress → nudge → auto-
complete). This phase composes cleanly with 224/225.

## Tests (deterministic, no live model)

### `test/safe-writes.test.mjs` — new `describe('preparePatches duplicate-block guard (phase 226)')`

1. **Reproduction** — seed a file that already contains a multi-line guarded-
   listen block once plus a distinct anchor region. Patch: `search` = the anchor,
   `replace` = anchor + a verbatim copy of the block. Assert
   `failedPatches[0].reason === 'duplicate_block'`, `writes.length === 0`, and the
   file on disk is **unchanged** (the block appears exactly once, not twice). This
   pins the fix.
2. **Negative — single-line repeat allowed** — a patch whose `replace` is a single
   line repeating a common literal applies normally (`writes.length === 1`),
   proving `isMultiLineBlock` gating prevents false positives.
3. **Negative — normal multi-line insertion allowed** — a multi-line `replace`
   block that does NOT already exist in the file applies (appears once in `after`,
   `> 1` is false), `writes.length === 1`.
4. **Compose** — two patches to the same file: first duplicates a block (rejected),
   second is a clean edit. Assert the clean edit still applies (`writes.length ===
   1`, `failedPatches.length === 1`) — the rejected patch did not corrupt
   `target.content`.

### `test/tool-calls.test.mjs` — live `edit_file` steering

5. **live edit_file returns steering for duplicate_block** — `applyMode: 'live'`
   over a temp cwd seeded with the block once; dispatch an `edit_file` whose
   replace re-adds the block. Assert the returned JSON `error` contains the
   phase-226 wording ("already exists in the file") and the on-disk file is
   unchanged (no duplicate).

### Staged integration (scripted fake-model only, in the staged test module)

6. **staged stage skips a duplicating patch; construct stays single** — reuse the
   phase-224/225 scripted fake-model-server pattern: stage 1 writes `server.mjs`
   (block once) via the proposal; a later stage emits an `edit_file` whose replace
   re-adds the block; a scripted turn returns `STAGED_DONE`. Assert the final
   on-disk `server.mjs` contains the block **exactly once** (`countOccurrences ===
   1`) and the duplicating stage recorded `writeCount: 0` (phase-225 zero-applied
   arm). Proves the garbage write no longer reaches disk end-to-end.

## Done criteria

- [x] `preparePatches` rejects verbatim-duplicate multi-line blocks with
      `reason: 'duplicate_block'`, collecting into `failedPatches` without applying
      or mutating `target.content`; `isMultiLineBlock` helper added; single-line and
      ordinary edits unaffected.
- [x] `edit_file` live handler maps `duplicate_block` to actionable steering; no
      change to proposal-mode validation.
- [x] No changes to `runStagedPrompt` loop control / `prepareChanges` signature;
      composes with the phase-225 zero-applied arm.
- [x] New `test/safe-writes.test.mjs` describe block (cases 1–4) incl. the exact
      reproduction (file is NOT doubled) and both negatives.
- [x] New `test/tool-calls.test.mjs` live-mode steering test (case 5).
- [x] Staged integration test (case 6) asserting the on-disk construct appears once.
- [x] `npm run format` clean. Full suite passes. `npm run check` clean.
- [x] `process/decisions.jsonl` entry: the duplicate-block rule, the `> 1` +
      multi-line gating and why it is low-false-positive, the explicit rejection of
      the broad `replace ⊇ search` heuristic (breaks legitimate wraps), the
      `failedPatches`-not-throw choice; reference `failures.jsonl`
      `223-run3-multi-write-collision`.
- [x] Blog `blog/226-patch-duplicate-block-guard.md` (the SyntaxError failure +
      the data-layer fix).
- [x] NEXT.md FIFO: delete the shipped "edit_file patch collisions in multi-write
      stages" candidate; update the frontier note (phase 226).
- [x] `roadmap.md`: `- [x] 226 Prevent edit_file Patches From Duplicating a Block`.
- [x] Commit (small, focused; do not push).

## Risks / things to watch

- **Over-rejection:** a file that legitimately needs two identical multi-line
  blocks would be blocked. Mitigation: multi-line gating + the `write_file` escape
  hatch in the steering message; rare in generated code. Documented in decisions.
- **Composition with phase-225:** a stage whose only change is a rejected patch
  becomes zero-applied — correct and already handled; the phase-225 arm is gated on
  `allWrites.length > 0` and N=2, so a single rejected patch nudges before
  completing (case 6 asserts the zero-applied record, not premature completion).
- **Normalization consistency:** compare `normalized.replace` (post-
  `normalizePatch`), not the raw `patch.replace`.
- **Syntax gate backstop:** keep `runSyntaxGateIfNeeded` as the backstop for
  duplications this heuristic does not catch (e.g. duplicated single-line
  declarations); this phase removes the common multi-line case before it lands.
