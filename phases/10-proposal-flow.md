# Phase 10: Proposal Flow

## Goal

Connect model output, JSON extraction, safe writes, and verification.

## Build Steps

- [x] Accept `{ "files": [{ "path": "...", "content": "..." }] }`.
- [x] Add `--dry-run`.
- [x] Add `--yes`.
- [x] Run optional `--test` commands after writes.
- [x] Write `writes.json` and `tests.json`.

## Done Criteria

- [x] Fake model test produces a proposal.
- [x] Dry-run does not modify files.
- [x] Apply modifies files and records backups.
- [x] Blog post documents the first full coding loop.
