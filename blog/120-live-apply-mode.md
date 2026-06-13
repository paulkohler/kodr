# Phase 120 — Live Apply Mode (opt-in)

Kodr's default is proposal mode: every write lands in a `ProposalDraft`, and the whole set is applied in one step at run end after optional review. That is the right default — it gives you a chance to inspect before anything touches disk. But there is a real cost. A model writing five files in succession can't read its own work mid-run. `run_command` against a file it just "wrote" fails with ENOENT. Phase 119's devstral validation exposed this concretely: it called `write_file`, then immediately called `run_command node --test` to verify, and hit a missing-file error on every call.

Phase 120 adds a one-flag escape hatch: `--apply-mode live`. In live mode, writes land on disk the moment the tool returns. The model's next `read_file` or `run_command` sees actual files. The safety net is unchanged — every live write uses the same `prepareWrites` / `preparePatches` path that proposal mode uses at run end, so a backup is created and `kodr undo` works identically.

## Why a flag, not a per-model setting

Apply policy is a workflow choice, not a capability dimension. A team shipping to production wants proposal mode with mandatory review. A developer iterating on a personal script wants live mode so the model can run and fix its own tests. Neither preference is a function of which model is running. Routing apply policy through the model profile would couple infrastructure to use-case intent in exactly the wrong direction.

`--apply-mode <proposal|live>` is the external surface. `applyMode` is the project config key for a persistent default. Precedence: flag > config > builtin (proposal). `configSources.applyMode` records where the value came from.

## How live mode works

In live mode, the `write_file` and `edit_file` tool handlers call `prepareWrites` and `preparePatches` with `apply: true` before returning their result to the model. The returned `writeRecord` — containing `hash`, `backupPath`, and `diff` — is stored on the `ProposalDraft` entry alongside the content.

At run end, `buildLiveWriteRecords` collects those stored records from the draft. The end-of-run `prepareChanges` call filters out entries already marked `applied` so nothing is written twice. The live records are prepended to whatever end-of-run writes.json would have contained anyway, producing a single unified manifest for `kodr undo`.

The interactive review gate is skipped in live mode (`applyDecision: 'live'`, `shouldApply: true` immediately). There is nothing to gate — the writes already happened.

## Proposal-mode read-back (L3)

The mid-session write-visibility gap is partially addressable without live mode. In proposal mode, `read_file` now checks `proposalDraft.getCapturedContent(path)` before going to disk. If the path matches a pending `write_file` capture, it returns the captured content prefixed with a note: `[pending write — not yet on disk]`. This is a cheap answer for the common case: a model writes `foo.mjs` and then reads it back to verify what it wrote.

The note is intentional. We want the model to know this content hasn't touched disk yet — it's not the same as a successful write followed by a successful read. The model is working with a draft.

`edit_file` captures are not satisfied this way. An edit capture stores `{path, search, replace}` — not the resulting full file content — because the model may issue several edits to the same file and the intermediate states aren't tracked. The materialized-worktree path (see NEXT.md) would handle that correctly; this phase handles only the write_file case.

## kodr undo still works

The undo path was the main design constraint. `findLastAppliedRun` scans `.kodr/runs/` for the most recent `writes.json` with `applied: true` and non-empty `writes`. That contract is unchanged. Live mode's `writeRecord` values — produced by `prepareWrites` and `preparePatches` — carry the same `hash` and `backupPath` fields that proposal-mode writes carry. `undoLastApply` reads them identically.

One constraint: the undo test must not use `--out <name>` to redirect the run directory outside `.kodr/runs/`, because `findLastAppliedRun` only scans there. That is correct behaviour, not a bug — a run outside `.kodr/runs/` is a named artifact, not a session's latest run.

## Forensics and kodr why

`summary.applyMode` is recorded for every run. `kodr why` adds an apply-mode note to the Edit Application step in the causal story: `[apply mode: live — writes applied during the run]` or `[apply mode: proposal — applied at completion]`. This makes the undo story legible: if you're reading a `why` report trying to understand why certain files changed, you want to know whether the changes landed live or in batch.

## What live validation will tell us

Live mode's core question is whether the mid-session visibility gain outweighs the loss of the review gate. In proposal mode, a corrupted or badly-structured file is caught at the review step — you see the diff, you say no. In live mode, the model's mistakes land before you see them. The undo path is the recovery, not prevention.

The expected finding is that local models doing iterative code generation (write → test → fix) benefit from live mode because the run actually converges, while models doing single-pass architectural rewrites should stay in proposal mode where you can review the full proposal before committing. The flag makes both workflows available without changing the default.
