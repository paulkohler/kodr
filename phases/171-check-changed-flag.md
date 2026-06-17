# Phase 171: `kodr check --changed` Git-Aware Fast Check

## Motivation

`kodr check` scans the entire workspace. For large repos, a pre-commit hook
only needs to check git-modified files — running all sensors over thousands of
files is unnecessary. A `--changed` flag restricts the file set to only those
files reported by `git status --porcelain`, making the check fast enough to use
as a pre-commit gate.

## What this phase does

**`src/commands/check.mjs`**:
- Added `collectChangedFiles(cwd)`: calls `runGit(cwd, ['status', '--porcelain'])`,
  parses the XY-prefix porcelain format, handles renames (`old -> new`), and
  returns workspace-relative forward-slash paths. Returns `null` when not in a
  git repo (runGit throws or returns non-zero exit).
- `runCheck`: when `options.changed`, calls `collectChangedFiles`; on null
  (non-git workspace), emits a `--changed: not a git repository — scanning all files`
  note and falls back to the full workspace scan.
- Mode label in ANSI header: `workspace: /path (--changed: git-modified files only)`.

**`src/cli/args.mjs`**:
- Added `changed: false` to option defaults.
- Parse branch for `--changed`.
- Updated usage line: `kodr check [dir] [--changed] [--no-smoke] [--no-sensors] [--strict] [--json]`.
- Help text for `--changed`: restrict check to git-modified files only.

**`test/check-command.test.mjs`** — 1 new test:
- `--changed` in a non-git tmp dir falls back to full scan and returns ok.

## Done criteria

- [x] `kodr check --changed` restricts to git-modified files in a git repo.
- [x] Falls back gracefully to full scan when not in a git repo.
- [x] Mode label rendered in ANSI output header.
- [x] `git status` already in `GIT_COMMAND_ALLOWLIST`; no new permissions needed.
- [x] 1592 tests green; format + check clean.
- [x] Decisions logged; roadmap checked; version bump; committed.
