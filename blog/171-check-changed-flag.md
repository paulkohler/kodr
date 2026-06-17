# Phase 171: `kodr check --changed` — Git-Aware Fast Check

`kodr check` scans every file in the workspace. That's fine for small repos, but
in a large project it means re-checking hundreds of files that haven't changed.
Phase 171 adds `--changed`, a flag that restricts the file set to only what
`git status --porcelain` reports as modified.

## The implementation

`collectChangedFiles(cwd)` calls `runGit(cwd, ['status', '--porcelain'])` and
parses each `XY path` line. Renames get the right-hand path (`old -> new`). The
function returns `null` when the workspace is not a git repo (either runGit
throws, or the exit code is non-zero).

When `--changed` is passed and the workspace turns out not to be a git repo,
`runCheck` falls back to the standard full scan and emits a note explaining why.
This means `kodr check --changed` never silently produces an empty file list —
the fallback is always safe.

`git status` was already in `GIT_COMMAND_ALLOWLIST`; no permission change was
needed.

## Usage

```
kodr check --changed               # check only git-modified files
kodr check --changed --strict      # promote sensor warns to failures (CI)
kodr check --changed --json        # JSON output for scripting
```

The ANSI header now shows the mode label:

```
kodr check
  workspace: /path/to/repo (--changed: git-modified files only)
```

## Why `git status` not `git diff HEAD`?

`git diff HEAD --name-only` fails on fresh repos with no commits yet. `git
status --porcelain` works from the first `git init` onward — untracked files
appear as `?? path` and are included in the changed set, so new files are
checked too.
