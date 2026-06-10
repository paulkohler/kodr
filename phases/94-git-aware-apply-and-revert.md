# Phase 94: Git-Aware Apply And Revert

Merges planned phases 73 (Undo/Redo Run Reverts) and 74 (Git-Aware Apply and
Commit) into one phase.

## Planning Miss (the learning)

The original split was backwards. Phase 73 planned a bespoke patch-snapshot
undo/redo store "so this works in repositories without clean git state", with
git-awareness deferred to phase 74. Review during the phase 90–93 cycle showed
that almost every workspace Kodr targets is already a git repository, and git
already is the revert boundary: `git diff` is the review, `git checkout` /
`git revert` is the undo. Building a parallel snapshot store first would have
duplicated git badly and then been mostly dead code once 74 landed.

The miss is recorded here and in `process/decisions.jsonl` rather than erased:
phases 73 and 74 stay in `phases/` marked superseded.

## Goal

Make applied runs safe to accept confidently by using git as the recovery
primitive: know the tree state before applying, optionally commit each applied
run, and revert an applied run cleanly.

## Design

- Use an allowlist for git commands (`status`, `diff`, `add`, `commit`,
  `checkout`, `rev-parse`) via the controlled-exec pattern in
  `src/verification-runner.mjs` — no arbitrary git, no shell.
- Before apply, record tree state (`clean` / `dirty` / `not a repo`) in run
  artifacts. A dirty tree does not block apply, but the state is shown in the
  proposal review and recorded in `writes.json`.
- Opt-in auto-commit (`--commit`) stages and commits exactly the files Kodr
  applied, with a generated message referencing the run id and plan. Gated by
  the existing permission policy (phase 22).
- `kodr undo` reverts the last applied run's change set using the recorded
  write manifest plus existing safe-write backups; in a git workspace it
  verifies the files are unmodified since apply before reverting, and refuses
  with a clear message on conflict.
- TUI `/undo` flows through the same shared channel handler as the CLI.
- Non-git workspaces keep the existing safe-write backups as the fallback
  revert source; no new snapshot store is built.

## Non-Goals

- No push, rebase, branch, or stash operations.
- No redo stack in the first pass (re-running the run is the redo).
- No conflict auto-resolution.
- No automatic commits without explicit opt-in.

## Done Criteria

- [ ] Git command allowlist parsed and policy-tested with a fake runner; no
      command outside the allowlist can execute.
- [ ] Tree state recorded per apply and surfaced in review output.
- [ ] `--commit` commits only applied files, only on explicit opt-in, with a
      run-referencing message.
- [ ] `kodr undo` and TUI `/undo` revert the last applied run and refuse on
      conflicting later edits.
- [ ] Non-git fallback uses existing safe-write backups.
- [ ] Tests for allowlist, commit, undo, conflict refusal, and non-git
      fallback.
- [ ] Record decisions and any failures.
- [ ] Blog post (include the 73/74 planning-miss story).
- [ ] Mark roadmap complete and commit.
