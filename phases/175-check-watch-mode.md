# Phase 175: `kodr check --watch` Mode

## Motivation

`kodr check` is a one-shot diagnostic. During active development it's useful to
have it re-run automatically whenever a file changes, giving instant feedback
without manually triggering the check after every save.

## What this phase does

**`src/commands/check.mjs`**:
- Added `watch` to imports from `node:fs/promises`.
- `WATCH_DEBOUNCE_MS = 300`: change events within 300ms of each other trigger
  only one re-run.
- `WATCH_EXCLUDED`: set of directory names to skip (mirrors `EXCLUDED_DIRS`).
- `runCheckWatch(options, io, signal?)`:
  - Runs `runCheck` immediately (initial check).
  - Creates an internal `AbortController`; merges the caller's optional
    `AbortSignal` and SIGINT into it.
  - Calls `fs.promises.watch(cwd, { recursive: true, signal: ac.signal })`.
  - Debounces file-change events: 300ms after the last event, re-runs check.
  - Skips events from excluded directories (`.git`, `node_modules`, …).
  - On `AbortError` (SIGINT or caller abort), exits the loop cleanly.
  - Always writes `\n` in the `finally` block so the shell prompt is on a clean
    line after exit.
- Exported from `check.mjs`.

**`src/cli/args.mjs`**:
- Added `watch: false` to defaults.
- Parse branch for `--watch`.

**`src/app.mjs`**:
- Updated the `check` dispatch to call `runCheckWatch` when `options.watch`.

**`test/check-command.test.mjs`** — 1 new test:
- `runCheckWatch` runs the initial check and exits cleanly when the caller's
  `AbortSignal` fires after 50ms.
- Verifies the output contains `syntax check` and `watching for changes`.

## Design note: AbortSignal over SIGINT-only

Using `fsPromises.watch(cwd, { signal })` with an `AbortController` is the
cleanest way to close the watcher: when the signal aborts, Node.js throws
`AbortError` inside the `for await` loop, which exits naturally. The alternative
(`watcher.return()`) does not reliably unblock the event loop on all platforms.

The `signal` parameter on `runCheckWatch` is optional and used for testing;
production callers use SIGINT (Ctrl-C) which is wired into the same
`AbortController`.

## Done criteria

- [x] `kodr check --watch` re-runs on file changes with 300ms debounce.
- [x] Exits cleanly on SIGINT (Ctrl-C) or AbortSignal.
- [x] 12 tests in check-command.test.mjs pass.
- [x] Full suite green; format + check clean.
- [x] Decisions logged; roadmap checked; version bump; committed.
