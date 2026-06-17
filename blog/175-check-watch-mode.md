# Phase 175: `kodr check --watch` Mode

`kodr check` is fast — 50–200ms for a typical workspace. Fast enough to run
on every file save. Phase 175 adds `--watch` so it does.

## Usage

```
kodr check --watch                     # re-run on any file change
kodr check --watch --changed --strict  # watch only changed files, CI mode
```

Press Ctrl-C to exit.

## Implementation

`runCheckWatch` runs an initial check, then starts `fs.promises.watch` with
`{ recursive: true }`. On each file-change event, a 300ms debounce timer fires
and re-runs `runCheck`. The watcher skips events from excluded directories
(`.git`, `node_modules`, `dist`, …) to avoid reacting to build artifacts.

Termination uses an `AbortController`: both SIGINT (Ctrl-C) and an optional
caller-provided `AbortSignal` (used in tests) are wired into the same controller.
`fs.promises.watch` accepts a `signal` option, so when the controller aborts it
throws `AbortError` inside the `for await` loop — the watcher closes, the loop
exits, and the event loop drains cleanly.

## Why `fsPromises.watch`?

The older `fs.watch` (callback API) requires explicit `.close()` and is error-
prone to clean up. The `fsPromises.watch` async iterator with a `signal` option
is the Node.js 24 idiomatic API: structured concurrency, no manual handle
tracking, no platform-specific gotchas with `.return()`.

## Debounce

Editors typically emit 2–5 file-system events per save (create temp file, rename,
update metadata). A 300ms debounce collapses these into a single re-run and keeps
the output readable.
