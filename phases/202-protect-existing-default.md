# Phase 202: protectExisting On By Default

## Motivation

Every Session 2 example run (collab-notes, auth-app) introduced regressions by
rewriting Session 1 files from scratch. The model produced `files[]` entries
(full content) for files that already existed, silently discarding the original
API contract. Tests then failed in ways that looked like code bugs but were
actually API breakage — `startServer(pool, port)` instead of `startServer(port)`,
`app.post('/register', register(pool))` passing a Promise as an Express handler.

`protectExisting` already existed as an opt-in (`--protect-existing`) that blocked
`files[]` writes to git-tracked files. Two problems:

1. **Off by default** — callers had to remember to pass the flag.
2. **Git-only** — the check used `git ls-files`, so it never fired in the example
   workspaces under `~/src/kodr-testing/` which aren't git repos.

## What this phase does

- Extends the check from git-tracked to **any file that exists on disk**
  (uses `readExisting` which is already called in `prepareWrites`).
- Removes `isGitTracked` and its `execFile` import (now unused).
- Changes the default from `false` to `true`.
- Adds `--no-protect-existing` as the opt-out flag.
- Updates the help text example.
- Bumps package.json to `0.0.201`.

With this change, a Session 2 run that tries to fully overwrite `src/server.mjs`
will throw immediately rather than writing and then failing tests. The heal loop
gets a `SafeWriteError` with the file path — a more actionable signal than a
runtime test failure.

## Done criteria

- [x] `protectExisting` check uses disk existence, not git-tracking.
- [x] `isGitTracked` and `execFile` import removed.
- [x] Default changed to `true` in `args.mjs`.
- [x] `--no-protect-existing` added as opt-out.
- [x] 3 new tests: blocks overwrite, allows create, allows patch.
- [x] `npm run format` passes.
- [x] All 110 tests pass.
- [x] `npm run check` passes.
- [x] Committed.
