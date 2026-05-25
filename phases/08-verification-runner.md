# Phase 08: Verification Runner

## Goal

Run checks without exposing a shell.

## Build Steps

- [ ] Add shell-free command parser.
- [ ] Allowlist `npm test`, `npm run test`, `node --test`, and safe `node --check <file>`.
- [ ] Add timeout support.
- [ ] Save `.koder/last-test.md`.

## Done Criteria

- [ ] Tests reject injection-shaped commands.
- [ ] Tests cover timeout behavior.
- [ ] Blog post explains the command allowlist.
