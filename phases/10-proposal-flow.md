# Phase 10: Proposal Flow

## Goal

Connect model output, JSON extraction, safe writes, and verification.

## Build Steps

- [ ] Accept `{ "files": [{ "path": "...", "content": "..." }] }`.
- [ ] Add `--dry-run`.
- [ ] Add `--yes`.
- [ ] Run optional `--test` commands after writes.
- [ ] Write `writes.json` and `tests.json`.

## Done Criteria

- [ ] Fake model test produces a proposal.
- [ ] Dry-run does not modify files.
- [ ] Apply modifies files and records backups.
- [ ] Blog post documents the first full coding loop.
