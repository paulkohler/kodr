# Phase 139 — Under-Delivery Guard

## Motivation

Phase-137 dogfood: gpt-oss-20b delivered 1 of 3 files with `finish_reason:stop`.
After phase 137 fixed the extractor, the delivered file landed — but the other
two were absent. The harness had no mechanism to detect or recover the missing
files.

The information to detect the gap was always in the task prompt: it listed three
explicit file paths. The proposal had one. That's checkable.

## Design

After extracting a valid OK proposal on `finish_reason:stop`:

1. Run `extractPromptFilePaths(prompt)` — a regex that finds path-like tokens
   (`src/store.mjs`, `test/cli.test.mjs`) and excludes node specifiers and
   version strings.
2. Compare against `proposal.files.map(f=>f.path)` + `proposal.patches.map(p=>p.path)`.
3. If any prompt-named path is absent: issue ONE continuation nudge with the
   missing file list.
4. Merge additional files/patches from the nudge response into the proposal.
5. Record `summary.deliveryNudge: { prompted: [...], recovered: [...] }`.

Guard fires at most once per run (`options.deliveryNudge !== false` gate).
Does NOT fire on `tool_calls` or `length` finish reasons, non-OK proposals,
or prompts with no explicit path names.

## Files changed

- `src/app.mjs`: `extractPromptFilePaths` exported helper + nudge logic in
  `runPrompt` after proposal merge.
- `test/app.test.mjs`: 4 unit tests for `extractPromptFilePaths`.

## Done criteria

- [x] `extractPromptFilePaths` exported and tested (4 unit tests).
- [x] Nudge logic in `runPrompt`: fires on missing prompt-named paths, merges
      additional files, records `summary.deliveryNudge`.
- [x] Complete-delivery run does NOT trigger nudge (`deliveryNudge: undefined`).
- [x] Full suite green (1372/1372); format + check pass.
- [x] `process/decisions.jsonl` entry.
- [x] Blog post `blog/139-under-delivery-guard.md`.
- [x] NEXT.md: gpt-oss under-delivery item removed.
- [x] Version bumped to 0.0.139; roadmap line checked; committed.
