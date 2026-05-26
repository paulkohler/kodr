# Phase 15: Local Bin Install

## Goal

Make local usage easy from any directory.

## Build Steps

- [x] Add `npm run install-local`.
- [x] Write a shell shim to `~/.local/bin/koder`.
- [x] Support custom `--dir` and `--name`.
- [x] Test installed shim with `--version`.

## Done Criteria

- [x] `./koder --version` works.
- [x] Installed temp shim works in tests.
- [x] Blog post explains local command ergonomics.
