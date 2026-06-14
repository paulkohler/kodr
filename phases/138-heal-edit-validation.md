# Phase 138 — Heal Edit Validation: Per-Edit Immediate Feedback

## Motivation (confirmed from real artifacts)

In phase 135 re-validation (`~/src/kodr-testing/phase-135/heal-revalidate-qwen/`), outer
turn 2 produced 3 `no_match` failures out of 5 `edit_file` calls. The model did call
`read_file` first — it saw the current file state. But it then issued 5 edits at once,
and 3 of them searched for text that **outer turn 1 had already removed**. With more
budget (phase 136), the model has turns to recover, but it wastes them.

**Root cause (verified from `repairs/turn-2/writes.json` and `raw-response.json`):**

In **proposal mode**, `edit_file` calls `proposalDraft.recordPatch(path, search, replace)`
unconditionally — no search-text validation at call time. The model issues N edits in
one tool-message, they are all silently recorded, and only after the entire inner tool
loop ends does `preparePatches` report which ones failed. The model gets no per-edit
signal during the turn.

In **live mode**, `edit_file` calls `preparePatches(cwd, [patch], { apply: true })` which
validates immediately and returns the current region on failure. The model can react
within the same turn.

**The fix:** Make proposal mode match live mode's per-edit signal:
- Keep a `Map<relPath, currentContent>` per registry session (the "edit accumulator").
- On first edit to a path: read the disk file into the accumulator.
- Before recording each edit: validate the search text against the accumulated content
  (disk + all earlier edits to that path in this session). If not found or ambiguous:
  return the same error + region hint that live mode returns. If found: apply the
  replacement to the accumulator and then record in the draft.

This lets the model course-correct within the same tool-call session instead of wasting
a full outer heal turn.

## What does NOT change

- **Draft recording**: still identical to today. `proposalDraft.recordPatch` is called
  exactly when it is now; we just gate it behind validation.
- **Live mode**: untouched. Live mode already validates per-edit via `preparePatches`.
- **`preparePatches` at end-of-turn**: still runs on the recorded draft. The accumulated
  content map is not used by `preparePatches` — they are independent. This is a net
  redundancy, but it means the final apply stays robust (works for writes too).
- **`ProposalDraft`**: no change. The accumulator lives in the tool registry closure.

## Design

### A — Export `countOccurrences` and `normalizePatch` from `src/safe-writes.mjs`

`normalizePatch` already encapsulates the whitespace-tolerance and unescape logic used
in `preparePatches`. Export both so `tool-calls.mjs` can reuse them without duplicating.

### B — Edit accumulator in `createBuiltinRegistry` (`src/tool-calls.mjs`)

```js
// Near proposalDraft/applyMode:
const editAccum = new Map(); // relPath → currentContent (disk + applied drafts)
```

In the `edit_file` handler, inside the `proposal` path (the `else` branch after the
`live` block), add validation before `proposalDraft.recordPatch`:

```js
// Lazy-load disk content for this path into editAccum.
if (!editAccum.has(path)) {
  const jailed = await jailedPath(cwd, path);
  let diskContent;
  try {
    diskContent = await readFile(jailed.absolute, 'utf8');
  } catch {
    // File not found — preparePatches will handle 'missing_target'; don't block.
    diskContent = null;
  }
  editAccum.set(path, diskContent);
}
const accumulated = editAccum.get(path);
if (accumulated !== null) {
  const normalized = normalizePatch(accumulated, { search, replace });
  const occurrences = countOccurrences(accumulated, normalized.search);
  if (occurrences !== 1) {
    const reasonLabel =
      occurrences === 0
        ? 'search text not found'
        : `search text matched ${occurrences} times (must match exactly 1)`;
    const regionHint =
      occurrences === 0 ? `\nClosest region:\n${closestRegion(accumulated, search)}` : '';
    return JSON.stringify({
      error: `edit_file patch failed: ${reasonLabel}. Recheck your search text against the current file content.${regionHint}`,
    });
  }
  // Update accumulator to reflect this edit, so subsequent edits validate
  // against the post-edit state.
  editAccum.set(path, accumulated.replace(normalized.search, normalized.replace));
}
// (file not found: fall through to proposalDraft.recordPatch; preparePatches handles it)
return proposalDraft.recordPatch(path, search, replace);
```

`closestRegion` is already imported from `safe-writes.mjs` for the live-mode path.
With this change it is also used for proposal mode — same import, no change.

### C — New test cases (`test/tool-calls.test.mjs`)

- **P1 – second edit stale**: two sequential `edit_file` calls to the same file;
  first succeeds and changes the content; second searches for the pre-edit text →
  gets `no_match` error immediately (not recorded in draft).
- **P2 – sequential edits both valid**: first edit changes A→B; second edit searches
  for B and changes it to C → both recorded, draft has two patches, `preparePatches`
  applies them correctly.
- **P3 – file not found graceful**: `edit_file` on a path that doesn't exist in the
  test cwd → falls through (null accumulated), `proposalDraft.recordPatch` records it,
  `preparePatches` produces `missing_target`. No hard error from the accumulator.
- **P4 – live mode unaffected**: live mode should still go through `preparePatches`
  directly; `editAccum` is not used. Confirm existing live-mode test still passes.

## Testing plan

```
npm test -- --test-name-pattern "edit_file"   # targeted
npm test                                       # full suite
npm run format
npm run check
```

Then run a real heal under kodr to confirm proposal-mode edits now fail fast
per-edit when the search text is stale. Test dir: `~/src/kodr-testing/phase-138/`.

## Done criteria

- [x] A: `countOccurrences` and `normalizePatch` exported from `safe-writes.mjs`; no
      callers inside the module broken (all internal calls still work).
- [x] B: `editAccum` validation in `createBuiltinRegistry`'s `edit_file` proposal path.
      Stale-hunk `edit_file` returns immediate per-edit error + region hint.
- [x] C: Tests P1–P4 pass; full suite green; `npm run format` and `npm run check` pass.
- [x] `process/decisions.jsonl`: per-edit validation in proposal mode.
- [x] `process/failures.jsonl`: stale-hunk cross-turn waste (heal turns 2–3 in 135
      re-validation; root cause: no per-edit validation in proposal mode).
- [x] Blog post `blog/138-heal-edit-validation.md`.
- [x] NEXT.md: remove stale-hunk item; add file-count guard and any new items.
- [x] Version bumped to 0.0.138; roadmap line checked; committed.
