# Phase 181: `kodr hook status`

## Motivation

`kodr hook install/uninstall` manage the pre-commit hook, but there was no way to
inspect the current state without reading the hook file directly. A `status`
subcommand fills that gap: one command reports whether the hook exists and whether
kodr owns it.

## What this phase does

**`src/commands/hook.mjs`**:
- `runHookStatus(options, io)`:
  - Uses `resolveHooksDir` to find `.git/hooks`.
  - Returns `{ ok: false }` when not in a git repo.
  - When no hook file exists: prints `pre-commit hook: not installed`; returns
    `{ ok: true, hookStatus: 'none' }`.
  - When hook contains `HOOK_HEADER`: prints installed-by-kodr message with
    path and command; returns `{ ok: true, hookStatus: 'kodr', hookPath }`.
  - When hook is foreign: prints foreign message with path and uninstall tip;
    returns `{ ok: true, hookStatus: 'foreign', hookPath }`.
- `runHook` dispatch: added `'status'` branch; updated available list to
  `install, status, uninstall`.

**`test/hook-command.test.mjs`** — 4 new `runHookStatus` tests + 1 `runHook`
dispatch test; 19 total:
- Not-in-git-repo guard.
- Not installed → `hookStatus: 'none'`.
- Kodr hook installed → `hookStatus: 'kodr'`, output matches installed-by-kodr.
- Foreign hook → `hookStatus: 'foreign'`, output mentions foreign.
- `runHook` dispatches to status.

## Done criteria

- [x] `kodr hook status` reports `none`, `kodr`, or `foreign`.
- [x] Not-in-git-repo guard.
- [x] 19 tests in hook-command.test.mjs pass.
- [x] format + check clean; decisions logged; roadmap checked; version bump; committed.
