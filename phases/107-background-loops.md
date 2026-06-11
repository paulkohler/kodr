# Phase 107: Free-Token Background Loops

## Goal

A killer local-first application: workflows too token-expensive to run on metered
APIs. One narrow, well-gated entry point: `kodr watch --test "npm test"`. On file
change, run the test command; on failure, propose a repair as a *pending review* —
never auto-applied. The phase 98 gate machinery holds it; artifacts and undo make
it safe; the phase 103 no-progress detection prevents spinning.

## Changes

### `src/watcher.mjs` (new)

- `createWatcher(cwd, options)` — wraps `node:fs` `watch()` with `recursive: true`.
  Debounces events (500ms default). Ignores `.git`, `.kodr`, `node_modules`,
  `dist`, `build`, `coverage`. Returns `{ on, close }`.
- `runWatchLoop(options, io, channel)` — the main loop. Creates a watcher, runs
  `runVerification` on each debounced change, and if tests fail, calls the channel
  with `kind: 'run-turn'` and `dryRun: true` to produce a pending review proposal.
  Returns `{ close, _state }`.

Safety invariants:
- `dryRun: true` / `yes: false` — never auto-applies.
- One repair at a time — skips if `state.pendingRepair` is already set.
- No-progress guard — after `DEFAULT_MAX_REPAIR_ATTEMPTS` (3) failed attempts with
  no user action, stops proposing until the next file change.
- Accepts `options._verificationRunner` for test injection.

### `src/app.mjs`

- Added `watch` command dispatch block. Requires `--test`. Starts `runWatchLoop`
  then blocks on SIGINT/SIGTERM, calling `handle.close()` on signal.
- Added `kodr watch --test CMD` to usage text with full flag description.

### `test/watcher.test.mjs` (new)

9 tests across two `describe` suites:

- `createWatcher`: detects changes, ignores `.git`, ignores `node_modules`,
  debounces rapid writes, stops after `close()`.
- `runWatchLoop`: passes do not call channel, state machine initialises correctly,
  no-progress state exposed via `_state`, pending-repair guard accessible.

### `roadmap.md`

Added `- [x] 107 Free-Token Background Loops`.

### `package.json`

Bumped version to `0.0.107`.

## Done criteria

- [x] `createWatcher` wraps `fs.watch` with debounce and ignore-list
- [x] `createWatcher` returns `{ on, close }`
- [x] `runWatchLoop` runs verification on file change
- [x] `runWatchLoop` calls channel with `dryRun: true` on failure
- [x] `runWatchLoop` never calls channel when tests pass
- [x] One-repair-at-a-time guard (`pendingRepair` flag)
- [x] No-progress guard (`repairCount >= MAX_REPAIR_ATTEMPTS`)
- [x] `kodr watch --test CMD` wired in `app.mjs` dispatch
- [x] Usage text documents `watch` and `--test`
- [x] 9 watcher tests pass
- [x] `npm run check` clean
- [x] `package.json` version bumped to `0.0.107`
- [x] `process/decisions.jsonl` updated
- [x] Blog post written
