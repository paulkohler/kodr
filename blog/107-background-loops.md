# Phase 107 — Free-Token Background Loops

The most compelling argument for local-first AI tooling is economic: metered APIs
charge per token, so running a repair loop in the background while you code is
expensive on Anthropic or OpenAI. On a local model it costs nothing. Phase 107
turns that economic advantage into a concrete feature: `kodr watch`.

## What shipped

**`src/watcher.mjs`** — a zero-dependency module built entirely on Node.js 24
built-ins:

- `createWatcher(cwd, options)` wraps `fs.watch` with `recursive: true`, debounces
  events at 500ms, and filters out `.git`, `.kodr`, `node_modules`, `dist`,
  `build`, and `coverage`. Returns a simple `{ on, close }` interface.
- `runWatchLoop(options, io, channel)` is the main loop. On each debounced change
  it calls `runVerification`; if the tests fail it asks the channel for a repair
  proposal with `dryRun: true` — never auto-applied. Returns `{ close, _state }`.

**`kodr watch --test "npm test"`** — new CLI command. On file change, runs the
allowlisted test command. On failure, proposes a repair as a pending review.
Ctrl+C or SIGTERM stops cleanly.

## Safety first

Several deliberate constraints make this safe to run in the background:

- **Never auto-applies.** Every repair is `dryRun: true`. The phase 98 apply
  prompt or TUI review gate stands between the proposal and the filesystem.
- **One repair at a time.** If a repair is already pending, the loop skips
  proposing another until the user accepts or rejects.
- **No-progress guard.** After three failed repair attempts with no user action,
  the loop stops proposing until the next file change. This is the phase 103
  no-progress detection repurposed for the watch context.
- **Interruptible.** `close()` stops the watcher and the running debounce timer
  immediately.

## Implementation notes

`fs.watch` with `recursive: true` is the Node.js 24 native answer to chokidar.
It has some rough edges on Linux (inotify limits) and the event payloads can be
coarse, but for a local-first tool watching a single project directory it is
entirely adequate and adds zero dependencies.

The verification runner is injected via `options._verificationRunner` to keep
tests fast and deterministic — no real subprocess spawning needed to verify the
loop logic.

## Tests

9 tests in `test/watcher.test.mjs`, split across two `describe` suites. The
`createWatcher` suite uses real filesystem writes to a temp directory with a
50ms debounce. The `runWatchLoop` suite uses a mock verification runner and a
mock channel to validate the state machine without touching the network or
spawning subprocesses.

## What this enables

With `kodr watch` running in a terminal pane, saving a file that breaks tests
triggers an automatic repair proposal. The user reviews it in the TUI and either
accepts or rejects. The loop costs nothing beyond local CPU — no API bill, no
rate limits, no latency from a remote model.
