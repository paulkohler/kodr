# Phase 142 — Watch Accept Prompt

## Motivation

`kodr watch` detects failing tests, proposes a repair, and prints:
"Use /accept or /reject in TUI." But the TUI integration doesn't exist and the
watch loop runs standalone. The proposal is discarded — there's no way to accept
it without running a separate `kodr tui` session.

In interactive (TTY) mode the fix is straightforward: after generating a repair
proposal, show the changed files and prompt "Accept repair? [y/N]". If
accepted, call the `apply-proposal` channel path (already used by the TUI) to
apply the writes to disk. If rejected, discard and wait for the next change.

## Design

In `runWatchLoop`, after a successful repair (non-null proposal):

1. Show a compact write summary: file count and paths.
2. If `io.stdin.isTTY`:
   - Write "Accept repair? [y/N] " and read a single line.
   - If 'y' / 'yes': call `channel({ kind: 'apply-proposal', proposal, runDir })`.
   - Otherwise: discard, print "Rejected. Watching for changes."
3. If not TTY (piped): keep the current pending-review message.

The repair run stays `dryRun: true` so no writes land before the user decides.
`state.pendingRepair` is cleared on both accept and reject.

## Files changed

- `src/watcher.mjs`: `runWatchLoop` — post-proposal prompt + accept path.

## Done criteria

- [x] TTY accept prompt: shows proposed files and waits for y/N input.
- [x] 'y': applies via apply-proposal channel; prints apply result.
- [x] 'n' / empty: discards, clears pendingRepair, continues watching.
- [x] Non-TTY path: unchanged (pending-review message).
- [x] No-progress guard state explicitly surfaced in the prompt message.
- [x] Unit tests cover accept, reject, and non-TTY paths (3 new tests).
- [x] Full suite green (1387/1387); format + check pass.
- [x] `process/decisions.jsonl` entry.
- [x] Blog post `blog/142-watch-accept-prompt.md`.
- [x] NEXT.md: Watch-Meets-TUI item removed; suggested order updated.
- [x] Version bumped; committed.
