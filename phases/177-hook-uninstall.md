# Phase 177: `kodr hook uninstall`

## Motivation

Phase 174 added `kodr hook install`. The natural counterpart is a remove command
that respects the same guard: only remove a hook that kodr installed.

## What this phase does

**`src/commands/hook.mjs`**:
- Updated import: added `unlink`; removed unused `access` and `rm`.
- `runHookUninstall(options, io)`:
  - Uses `resolveHooksDir` to find `.git/hooks` (handles worktrees).
  - Returns error when not in a git repo or hook file doesn't exist.
  - Reads hook content; checks for `HOOK_HEADER`; refuses without `--force`
    when the hook wasn't installed by kodr.
  - Calls `fs.unlink` to remove; prints confirmation.
- `runHook` dispatch: added `'uninstall'` branch; updated available list.

**`test/hook-command.test.mjs`** — 5 new tests across `runHookUninstall` + 1 in
`runHook`:
- Not-in-git-repo guard.
- Hook doesn't exist guard.
- Removes a kodr-installed hook (verifies file gone via ENOENT).
- Refuses foreign hook without `--force`.
- Removes foreign hook with `--force`.
- `runHook` dispatches to uninstall.

## Done criteria

- [x] `kodr hook uninstall` removes the hook when it was installed by kodr.
- [x] Guards: not-git-repo, not-exists, foreign-hook-without-force.
- [x] `--force` bypasses the foreign-hook guard.
- [x] 14 tests in hook-command.test.mjs pass.
- [x] format + check clean; decisions logged; roadmap checked; version bump; committed.
