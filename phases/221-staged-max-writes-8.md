# Phase 221 — Raise Staged Pipeline maxStageWrites to 8

## Goal

Phase-219 dogfooding: a 6-file Express + JWT + SQLite task hit the 5-file
`maxStageWrites` limit at stage 1 and produced `StagedProposalTooLargeError` with
zero files written. This is a hard cliff — there is no fallback, no partial apply,
no model guidance to split — just a complete run failure.

Standard Node.js project skeletons (server + db + auth + 3 test files) require
6–7 files. 5 is too tight. Raise to 8 to give one file of headroom above a typical
7-file layout.

## Changes

### `src/run-pipeline.mjs` — `runStagedPrompt`

Change the constant at ~line 1852:

```js
// Was:
const maxStageWrites = 5;
// New:
const maxStageWrites = 8;
```

The planning prompt and the per-stage prompt both interpolate `${maxStageWrites}`
so they update automatically.

### Tests

Search `test/` for any assertion on `maxStageWrites` value 5 or
`StagedProposalTooLargeError` with a 5-file threshold. Update to 8.

In `test/app.test.mjs`, add a test:
1. A staged proposal with 8 file writes succeeds (does not throw `StagedProposalTooLargeError`).
2. A staged proposal with 9 file writes throws `StagedProposalTooLargeError`.

## Done criteria

- [x] `maxStageWrites` changed from 5 to 8.
- [x] Existing tests that referenced limit=5 updated to 8.
- [x] 2 new boundary tests pass (8 ok, 9 throws).
- [x] `npm run format && npm run check` clean.
- [x] `process/decisions.jsonl` entry added.
- [x] Blog post exists.
- [x] Roadmap entry marked done.
- [x] Commit made.
