# Phase 208 — deliveryNudge False-Positive Path Extraction Fix

## Goal

`deliveryNudge` fires a second model turn and creates files when it finds
path-like strings in freeform prompt text, not just in the model's structured
proposal (`files[].path`, `patches[].path`). Phase-209 dogfooding saw three
spurious files written in every file-upload run:

- `store.mjs` — bare name referenced mid-sentence in a prose description
- `test.txt` — from `filename="test.txt"` inside a code-block helper
- `files/test.txt` — from `fs.writeFile('files/test.txt', ...)` in a code block

Tests still passed (file contents were benign), but phantom files are a
correctness problem. The fix: restrict `extractPromptFilePaths` to paths that
are (a) outside fenced code blocks and (b) at the start of a line when bare
(no directory separator).

## Changes

### `src/run-pipeline.mjs` — `extractPromptFilePaths`

1. Strip fenced code blocks (` ``` `) before scanning.
2. For paths **with** `/`: accept as before (unambiguously a file path).
3. For bare names (no `/`): only accept when the path appears at the **start of
   a line** — i.e., nothing but optional whitespace / bullet before it.
   Bare names embedded mid-sentence (`the store.mjs module`) are rejected.

### `test/app.test.mjs` — new test cases

Add to the `extractPromptFilePaths (Phase 139)` suite:

- Paths inside fenced code blocks are ignored.
- Bare names mid-sentence are ignored.
- Paths with `/` inside code blocks are ignored.
- Bare names at line-start ARE extracted.

## Done criteria

- [x] `extractPromptFilePaths` strips fenced code blocks before scanning.
- [x] Bare names (no `/`) are accepted only when at line start.
- [x] New unit tests cover all four cases.
- [x] Existing tests still pass.
- [x] `npm run format && npm run check` clean.
- [x] `process/decisions.jsonl` entry added.
- [x] Blog post exists.
- [x] Roadmap entry marked done.
- [x] Commit made.
