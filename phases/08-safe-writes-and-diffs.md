# Phase 08: Safe Writes And Diffs

## Goal

Turn model proposals into controlled filesystem transactions.

## Build Steps

- [x] Add path jail.
- [x] Reject absolute paths and `..`.
- [x] Reject symlink parent escapes.
- [x] Add dry-run diffs.
- [x] Add timestamped backups.

## Done Criteria

- [x] Tests cover path escapes.
- [x] Tests cover symlink escapes.
- [x] Tests cover dry-run and apply.
- [x] Blog post explains why model writes are untrusted.
