# Phase 226: Prevent edit_file Patches From Duplicating a Block

The phase-223 run-3 forensic found `src/server.mjs` with a duplicate
`export let server;` declaration and a doubled guarded-listen block. All 22
tests failed with `SyntaxError: Identifier 'server' has already been declared`.
The harness wrote provably-broken code to disk and reported the stage applied.
Phase 226 adds a deterministic guard that stops that write before it lands.

## The failure

Stage 1 wrote `server.mjs` with the listen guard once. Stage 2 emitted an
`edit_file` patch. The patch's `search` matched the port assignment line
exactly once — so `occurrences === 1` and `preparePatches` applied it. But the
patch's `replace` re-emitted the listen guard block, which was already in the
file from stage 1. Result: two copies of the guard on disk, one SyntaxError,
22 failing tests.

The existing `occurrences !== 1` check only looks at the *search* text. It does
not ask what the *replacement* adds. A patch that finds its anchor once and
inserts a block that already exists passes every existing guard cleanly.

## Why not the broad "replace contains search" heuristic

The obvious candidate — reject any patch where `replace` contains the full
`search` text — was considered and rejected. Legitimate wrapping edits have
exactly that shape: `search: 'foo()'` → `replace: 'try { foo() } catch {}'`,
or adding indentation inside a new `if`. Rejecting all of those would break
normal `edit_file` usage. The right target is the *observable bad outcome*:
a non-trivial block appearing in the file twice.

## The fix

After computing `after = target.content.replace(search, replace)` and **before**
committing `target.content = after`, check:

```js
const replaceBlock = normalized.replace;
if (isMultiLineBlock(replaceBlock) && countOccurrences(after, replaceBlock) > 1) {
    failedPatches.push({ path, reason: 'duplicate_block', ... });
    continue;
}
```

Two gates keep false-positive rates low:

**`countOccurrences > 1`** (not `>= 1`): the block *should* appear once in
`after` — the patch just inserted it. Rejecting on `> 1` means there is a
second copy the patch did not insert, which is the duplication.

**`isMultiLineBlock` (>= 2 non-blank lines)**: single-line edits that repeat a
common literal (`}`, an import) must never trip the guard. The phase-223
construct (multi-line guarded-listen block) is caught; a patch that replaces one
closing brace with another is not.

The failed patch goes into `failedPatches`, not a throw. `target.content` is not
mutated, so a subsequent valid patch to the same file still composes correctly.

## Steering

The `edit_file` live handler already maps `no_match` and `multiple_matches` to
human-readable labels. The `duplicate_block` reason gets the same treatment:
"the replacement block already exists in the file — applying it would create a
duplicate; edit the existing occurrence or use write_file for the full file."
This gives the model a concrete alternative when the guard fires.

## Tests

Six new test cases, all deterministic, no live model:

1. **Reproduction** — file has the listen guard once; patch whose `replace` is
   just the guard block (would produce two copies) is rejected with
   `reason: 'duplicate_block'`; file on disk is unchanged; block count = 1.

2. **Negative: single-line replace** — `isMultiLineBlock` returns false; patch
   applies normally; `failedPatches` empty.

3. **Negative: new multi-line block** — `replace` is a multi-line block that
   does not already exist; `countOccurrences(after, replaceBlock) === 1`; patch
   applies normally.

4. **Compose** — two patches to the same file: first is the duplicating patch
   (rejected), second is a clean edit. The clean edit still applies; the rejected
   patch does not corrupt `target.content`.

5. **Live edit_file steering** — `applyMode: 'live'`, same patch; returned JSON
   `error` contains "already exists in the file"; file on disk unchanged.

6. **Staged integration** — scripted fake-model: stage 1 writes the file; stage
   2 emits the duplicating patch; stage 3 returns `STAGED_DONE`. Asserts
   `implement-2.writeCount === 0` (phase-225 zero-applied arm) and the guard
   block appears exactly once on disk.

Test count moved from 1808 to 1814.

## Composes with phase 225

A stage whose only change is a rejected `duplicate_block` patch produces
`writeResult.writes.length === 0`. Phase 225 already handles this: the first
zero-applied stage gets a nudge, the second triggers `implicitDone`. Phase 226
simply ensures the duplicate never reaches disk — the no-progress machinery
handles the rest unchanged.
