# Phase 94: Git-Aware Apply And Revert

Phase 94 gives applied runs a recovery primitive: tree-state recording before
every apply, an opt-in `--commit` that commits exactly the applied files, and
`kodr undo` / TUI `/undo` to revert the last applied run.

## The Planning Miss

This phase exists because the original plan was wrong, and that is worth
keeping. Phases 73 and 74 were planned as a sequence: first build a bespoke
patch-snapshot undo/redo store ("so this works in repositories without clean
git state"), then add git-aware commits on top. Reviewing the backlog made the
ordering problem obvious: nearly every workspace Kodr targets is already a git
repository where git *is* the revert boundary — `git diff` is the review,
`git checkout` is the undo. Building a parallel snapshot store first would
have duplicated git badly and become dead code the moment the git phase
landed.

The fix was to merge the two phases, keep the superseded specs in `phases/`
with banners, and record the miss in `process/decisions.jsonl` instead of
erasing it. The non-git case did not need a new snapshot system at all: the
safe-write backups Kodr has created since phase 08 are already the revert
source; they just needed a manifest hash and a command on top.

## What Changed

- New `src/git-workspace.mjs`: an allowlisted git surface (`status`, `diff`,
  `add`, `commit`, `checkout`, `rev-parse`). The subcommand must be the first
  argument — `git -c ...` style pre-subcommand options are refused — and
  nothing outside the allowlist reaches a spawned process. Commands run
  without a shell with an injectable runner for tests.
- Tree state (`clean` / `dirty` / `not-a-repo`) is captured before every
  proposal apply and recorded in `writes.json`, `git.json`, the run summary,
  and the CLI output. A dirty tree never blocks; it informs.
- `--commit` (requires `--yes`) stages and commits exactly the applied files
  with a generated message referencing the run id. When `--test` is set and
  verification fails, the commit is skipped with a recorded reason — no
  commits of known-broken state.
- Safe writes now record a sha256 of each applied file's content in the write
  manifest. `kodr undo` (new `src/undo.mjs`, channel kind `undo-run`) finds
  the newest applied run, verifies every file still matches its applied hash,
  then restores backups and deletes created files. Any post-apply edit,
  deletion, or missing backup refuses the whole undo with a per-file conflict
  list. The revert is artifacted as `undo.json`, and a repeat undo refuses
  instead of walking further back in history.
- TUI gets `/undo` through the same shared channel handler as the CLI.

## Design Notes

Undo is backup-based, not git-based, on purpose. Git tree state is recorded
for context, but the revert mechanism is identical in git and non-git
workspaces, and it never needs `git checkout` of paths the model touched —
which also means undo cannot clobber unrelated staged work.

Hash-before-revert turned out to be the load-bearing decision. It converts
"undo might silently destroy your manual fixes" into "undo refuses and names
the files", which is the difference between a recovery primitive and a
footgun. The healing loop interacts correctly for free: repairs edit applied
files after the apply, so an undo after healing refuses rather than reverting
to the mid-heal state.

## Failures Hit During The Phase

The full test suite intermittently failed `healing.test.mjs`'s
"repairs a failing write with explicit apply" while the phase work was in
flight. A stash run confirmed it predated this phase: the test gave
`node --check` a 1000ms timeout, and under full-suite load the spawn can
exceed it, so the final verification flaked. The fix was a 5s timeout on that
test's verification calls (the deliberate 1s hung-turn timeout elsewhere in
the file is untouched). Recorded in `process/failures.jsonl`.

## Verification

- `test/git-workspace.test.mjs`: allowlist parsing (denied subcommands and
  pre-subcommand options never reach the runner), tree-state mapping, commit
  sequencing with a fake runner, suspicious-path refusal, and a real-git
  integration test that initializes a repository, commits one applied file,
  and asserts the unrelated dirty file stays out of the commit.
- `test/undo.test.mjs`: restore/delete behavior, conflict refusal on
  post-apply edits, missing-hash refusal for pre-phase runs, missing-backup
  and deleted-file conflicts, newest-applied-run selection skipping dry-runs,
  duplicate patch-record collapsing, and already-undone refusal.
- CLI smoke: `kodr undo` reverts a fixture run and refuses the second time;
  `--commit` without `--yes` errors out.
