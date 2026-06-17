# Phase 201: Test-Timeout Default in --test Runner

## Motivation

Three example runs (issue-tracker, collab-notes, auth-app) surfaced a pattern:
when a test creates a Promise that never resolves (e.g. a WebSocket `message`
handler registered after the event has already fired), `node --test` runs forever.
The overall process timeout kills the *process* after 60 s, but by then the heal
loop has been blocked for a full minute with no actionable feedback. Worse, the
exit code is non-zero due to a signal kill, not a test failure, so the error
message is less useful.

`node --test --test-timeout=<ms>` bounds each *individual* test. With a 10-second
per-test ceiling, a hung test fails fast, the test runner finishes normally with
a non-zero exit code and a clear "test timed out" message in stdout, and the heal
loop has something concrete to act on.

## What this phase does

In `runVerification`, after `parseVerificationCommand` returns, detect
`{ bin: 'node', args: ['--test', ...] }` and build an `effective` parsed object
that appends `--test-timeout=${testTimeoutMs}` before spawning. Default is 10 s;
callers can override via `options.testTimeoutMs`.

No changes to `parseVerificationCommand` — it stays a pure allowlist parser.
The timeout injection is a runtime concern that lives in the execution path.

## Done criteria

- [x] `runVerification` injects `--test-timeout=<ms>` for all `node --test`
      invocations.
- [x] Default is 10000 ms; overrideable via `options.testTimeoutMs`.
- [x] Non-node-test commands (e.g. `node --check`) are unaffected.
- [x] 3 new tests: injects timeout, respects custom value, skips non-test commands.
- [x] `npm run format` passes.
- [x] All 23 verification-runner tests pass.
- [x] `npm run check` passes.
- [x] Committed.
