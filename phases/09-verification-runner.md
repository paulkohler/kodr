# Phase 09: Verification Runner

## Goal

Run checks without exposing a shell.

## Build Steps

- [x] Add shell-free command parser.
- [x] Allowlist `npm test`, `npm run test`, `node --test`, and safe `node --check <file>`.
- [x] Add timeout support.
- [x] Save `.koder/last-test.md`.

## Done Criteria

- [x] Tests reject injection-shaped commands.
- [x] Tests cover timeout behavior.
- [x] Blog post explains the command allowlist.
