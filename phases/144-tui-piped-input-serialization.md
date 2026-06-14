# Phase 144 — TUI Piped-Input Serialization

## Motivation

A scripted session using piped stdin silently dropped commands that arrived
while a previous turn was in-flight. Specifically: piping `/status\n/quit\n`
to `kodr tui` showed the status output, then exited without printing "bye" —
`/quit` was lost. The TUI exited with `reason: 'eof'` instead of `reason: 'quit'`.

## Root cause

`rl.question()` registers a one-time `'line'` event listener each call. The
readline interface processes all buffered stdin data as `'line'` events without
waiting for `rl.question()` to be called. When two lines arrive from a pipe
(both are immediately available in the buffer), readline emits both `'line'`
events in sequence. The first call to `rl.question()` captures the first line.
The second `'line'` event fires during the `handleTuiLine()` `await` — before
the next `rl.question()` call is registered — so it fires into the void and the
line is permanently lost. Then readline sees EOF and closes itself. The next
`rl.question()` throws "readline was closed", which is caught and returns
`{ reason: 'eof' }`.

## Fix

Replace the `rl.question()` loop with `for await (const line of rl)`.

The readline async iterator (`Symbol.asyncIterator`) queues every `'line'`
event in an internal buffer and yields them on demand. Lines that arrive while
the `await handleTuiLine()` is running are queued rather than lost; they're
consumed on the next `for await` iteration.

In TTY (interactive) mode, `rl.setPrompt()` + `rl.prompt()` replaces the
prompt display that `rl.question()` previously handled. In non-TTY (piped)
mode, the prompt string is written manually before processing each line.

## Files changed

- `src/tui.mjs`: replaced `while(true) { await rl.question() }` with
  `for await (const line of rl)`.

## Done criteria

- [x] Bug reproduced: `/status\n/quit\n` piped to `kodr tui` exits with
  `reason: 'eof'` (not `'quit'`) and no "bye" message.
- [x] Fix: `for await (const line of rl)` drains all buffered lines in order.
- [x] End-to-end verification: piped `/status\n/quit\n` now shows
  `/status` output followed by "bye" and exits with `reason: 'quit'`.
- [x] Regression test `phase 144: serialises piped commands` added.
- [x] Existing TUI tests pass (1394/1394 total).
- [x] `process/decisions.jsonl` entry.
- [x] Blog post `blog/144-tui-piped-input-serialization.md`.
- [x] NEXT.md TUI piped-input item removed.
- [x] Version 0.0.144; committed.
