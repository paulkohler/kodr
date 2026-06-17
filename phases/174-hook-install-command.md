# Phase 174: `kodr hook install` Pre-commit Hook Installer

## Motivation

`kodr check --changed --strict` is exactly the gate you want in a pre-commit hook:
fast (git-modified files only), non-blocking on advisory warnings (strict mode),
and deterministic. Phase 174 adds `kodr hook install` to scaffold it with a single
command — no husky, no lint-staged, no external tooling.

## What this phase does

**`src/commands/hook.mjs`** (new file):
- `resolveHooksDir(cwd)` — calls `runGit(cwd, ['rev-parse', '--git-dir'])` to find
  the git directory (handles worktrees, nested repos). Returns the absolute
  `.git/hooks` path, or null when not in a git repo.
- `runHookInstall(options, io)`:
  - Returns error when workspace is not inside a git repo.
  - Reads existing hook content; if present and not a kodr-installed hook,
    refuses to overwrite unless `--force` is set.
  - Writes `pre-commit` with `#!/bin/sh` header and `kodr check --changed --strict`.
  - `chmod 0o755` to make it executable.
  - Idempotent: re-installing over a kodr-installed hook replaces it silently.
- `runHook(options, io)` — dispatches on `options.hookSubcommand`.

**`src/cli/args.mjs`**:
- Added `hookSubcommand: ''` to defaults.
- Positionals routing: `command === 'hook' && positionals.length === 2` → `options.hookSubcommand = positionals[1]`.

**`src/app.mjs`**:
- New `hook` dispatch block before `check`, lazy-imports `commands/hook.mjs`.

**`test/hook-command.test.mjs`** (new file) — 8 tests:
- Error when not in a git repo.
- Installs hook content correctly in a git repo.
- Hook file is executable after install.
- Re-installs over existing kodr hook (idempotent).
- Refuses to overwrite foreign hook without `--force`.
- Overwrites foreign hook with `--force`.
- `runHook` dispatches to install.
- `runHook` returns error for unknown sub-command.

## Done criteria

- [x] `kodr hook install` writes an executable pre-commit hook.
- [x] Idempotent re-install and `--force` overwrite covered.
- [x] Non-git-repo and foreign hook guard covered.
- [x] 1616 tests green; format + check clean.
- [x] Decisions logged; roadmap checked; version bump; committed.
