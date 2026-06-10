# Phase 74: Git-Aware Apply and Commit

> **Superseded by [phase 94](./94-git-aware-apply-and-revert.md)**, which
> merges this with phase 73. See `process/decisions.jsonl`. Kept for the
> record.

## Goal

Add an optional, bounded git workflow around applied diffs: stage and commit
applied changes with a generated message.

Auto-commit is a signature Aider feature and makes Kodr usable for real
iterative work — clean per-turn commits and easy revert. It also gives the
Phase 72 self-healing loop a natural rollback boundary.

## Design

- Use an allowlist for git commands (`status`, `add`, `commit`) via the
  controlled-exec pattern in `src/verification-runner.mjs` — no arbitrary git.
- Gate behind explicit opt-in and the existing permission policy (Phase 22).
- Dry-run by default, per AGENTS.md.
- Generated commit message references the run/plan.

## Non-Goals

- No push, rebase, or branch operations in the first pass.
- No automatic commits without explicit opt-in.

## Done Criteria

- [ ] Git command allowlist (status/add/commit) parsed and policy-tested with a
      fake runner.
- [ ] Commit only on explicit opt-in; default dry-run.
- [ ] Generated commit message references the run/plan.
- [ ] No git command outside the allowlist can execute.
- [ ] Add tests.
- [ ] Record decisions and any failures.
- [ ] Blog post.
- [ ] Mark roadmap complete and commit.
