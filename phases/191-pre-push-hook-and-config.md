# Phase 191: Pre-push Hook and Configurable Hook Lifecycle

## Motivation

`kodr hook install` baked a single command (`kodr check --changed --strict`) into the
pre-commit hook with no way to install a companion pre-push hook or to change the
gate command without editing the file by hand. The pre-push slot is the natural
complement: run the full (non-`--changed`) check before sharing work. Project-level
config should pin the exact command so teams can opt into `--deep` or custom strictness.

## What this phase does

- Added `--pre-push` flag to `kodr hook install` → installs `.git/hooks/pre-push`
  running `kodr check --strict` (no `--changed`; pre-push checks the full tree).
- Added `--pre-push` flag to `kodr hook uninstall` → removes the pre-push hook.
- Updated `kodr hook status` → reports both `pre-commit` and `pre-push` hooks in one
  call; returns `hookStatuses: { 'pre-commit': '...', 'pre-push': '...' }`.
- Added `hooks` key to `.kodr/config.json`: `{ "preCommit": "...", "prePush": "..." }`.
  Each field overrides the baked-in default for that hook type.
- `hookStatus` (top-level field on `runHookStatus` result) remains the pre-commit
  status for backward compatibility with callers that only checked one hook.

## Known limitations

- No way to install both hooks in a single `kodr hook install` call. The `--pre-push`
  flag selects which hook to target; install pre-commit first, then `--pre-push`.
- Config validation rejects unknown keys in the `hooks` block; only `preCommit` and
  `prePush` are accepted.

## Done criteria

- [x] `--pre-push` flag parsed in `args.mjs`.
- [x] `runHookInstall` installs `pre-push` when `options.prePush` is true.
- [x] `runHookUninstall` removes `pre-push` when `options.prePush` is true.
- [x] `runHookStatus` reports both hooks; returns `hookStatuses` object.
- [x] `hooks` config key validated in `project-config.mjs`.
- [x] Config-driven command override exercised in tests.
- [x] 11 new tests (8 hook-command, 6 project-config hooks block).
- [x] Kodr integration test: install, config override, uninstall, status all verified.
- [x] Tests pass.
- [x] Committed.
