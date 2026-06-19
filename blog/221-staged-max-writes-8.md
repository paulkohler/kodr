# Phase 221: Raising the Staged Pipeline File Limit to 8

## The cliff

Phase 219 dogfooding hit a complete run failure before a single file was written.
The task was straightforward: generate an Express + JWT + SQLite server with
authentication and tests. The model planned the work, then stage 1 returned 6 files
in its proposal.

The harness rejected it:

```
StagedProposalTooLargeError: Staged proposal touched 6 paths; limit is 5
```

Zero files on disk. The staged pipeline stopped. No steering, no fallback, no
retry with a split stage — just a hard abort.

## Why 5 was the wrong number

The `maxStageWrites` constant at 5 was set conservatively when the staged pipeline
was first written. It wasn't grounded in any project-size analysis. Five files felt
safe as an upper bound, but the dogfooding made the distribution concrete:

A minimal Node.js project with meaningful structure needs:

- `src/server.mjs` or `src/app.mjs`
- `src/db.mjs`
- `src/auth.mjs` (or similar domain file)
- `src/routes/*.mjs` (at least one)
- `test/server.test.mjs`
- `test/auth.test.mjs`
- `package.json`

That's 7 files before adding a README, config files, or a second route. A 5-file
cap hits the cliff on the first coherent project layout a model will produce for
a real task. The model isn't doing anything wrong — it's planning a reasonable
project structure — but the harness stops it cold.

## The fix is one line

```js
// src/run-pipeline.mjs, inside runStagedPrompt
const maxStageWrites = 8;  // was 5
```

The planning prompt and per-stage prompt both interpolate `${maxStageWrites}`, so
they update automatically. The limit check at `paths.length > maxStageWrites` also
updates automatically. No other changes.

8 gives one file of headroom above a typical 7-file layout. It matches the
`maxExecutionStages` cap that already exists in the same function.

## The test gap

There were no boundary tests for this constant. Nothing in the test suite was
asserting what value `maxStageWrites` held or testing the 5/6 boundary. The error
would have gone unnoticed in tests even if the limit had drifted to 3 by accident.

Two new boundary tests were added to `test/app.test.mjs`:

1. A staged proposal with exactly 8 file writes succeeds — no
   `StagedProposalTooLargeError`.
2. A staged proposal with 9 file writes throws `StagedProposalTooLargeError`.

Both tests use the fake model server: the plan turn returns an empty scratchpad,
and stage 1 returns an array of N files built via `Array.from({ length: N }, ...)`.
The 8-file test asserts `writeCount === 8`. The 9-file test asserts
`writeError.name === 'StagedProposalTooLargeError'`.

One existing test also asserted the old value in a prompt-content regex:
`/at most 5 total file writes/u` was updated to `/at most 8 total file writes/u`.

## Why not auto-split

The phase file mentioned auto-split as an alternative: if the model returns more
files than the limit, automatically split them across the current stage and a
synthetic next stage. That would be a better long-term answer — the harness could
absorb any proposal size and adapt its staging to fit. But it's a substantially
larger change involving split logic, re-queued stages, and edge cases around
patches vs. files. Raising the limit from 5 to 8 fixes the immediate cliff with
minimal risk and leaves auto-split as a future enhancement (it remains documented
in `NEXT.md` under the npm auto-install section for the next round of staged
pipeline work).

## What 8 doesn't fix

The underlying shape of the failure is a hard cliff: any stage that returns more
than `maxStageWrites` files fails completely, with no files applied. Raising from
5 to 8 pushes that cliff further out, but doesn't remove it. A task that needs 9
files in a single stage will still fail the same way. The real fix is auto-split
or a model-steering prompt that tells the model explicitly how many files to put
in each stage.
