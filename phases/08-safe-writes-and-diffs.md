# Phase 08: Safe Writes And Diffs

## Goal

Turn model proposals into controlled filesystem transactions.

## Build Steps

- [ ] Add path jail.
- [ ] Reject absolute paths and `..`.
- [ ] Reject symlink parent escapes.
- [ ] Add dry-run diffs.
- [ ] Add timestamped backups.

## Done Criteria

- [ ] Tests cover path escapes.
- [ ] Tests cover symlink escapes.
- [ ] Tests cover dry-run and apply.
- [ ] Blog post explains why model writes are untrusted.
