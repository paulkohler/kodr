# Phase 201: Test-Timeout Default in --test Runner

Three example runs — issue tracker, collaborative notes, full-stack auth app —
surfaced the same failure mode: a test that creates a Promise that never resolves
causes `node --test` to hang indefinitely. The test process is eventually killed
by the overall 60-second process timeout, but the exit is via signal, not via a
test failure, so the heal loop sees a cryptic process-killed error rather than
a clear "test X timed out."

The worst case was the WebSocket `NOTE_INIT` test in the collab-notes example.
The server sends `NOTE_INIT` immediately on connection, in the same I/O tick as
the `open` event. A test that registered its `message` handler after the connection
was already open would never receive it, and `node --test` would sit there forever.
The 60-second kill surfaced nothing the heal loop could repair.

## The fix

`node --test --test-timeout=<ms>` bounds each individual test. When a test times
out, the runner exits normally with a non-zero code and a readable message in
stdout: `Error: Test timed out after Xms`. That's something a heal pass can see
and act on.

In `runVerification`, after `parseVerificationCommand` returns, the execution path
now checks for `{ bin: 'node', args: ['--test', ...] }` and builds an `effective`
copy of the parsed args that appends `--test-timeout=${testTimeoutMs}`. The default
is 10 000 ms; callers can override via `options.testTimeoutMs`.

`parseVerificationCommand` itself is unchanged — it stays a pure allowlist parser
with no runtime concerns.

## What it looks like

Before:

```
# node --test hangs forever, killed after 60s:
ERR_TEST_FAILURE signal: SIGTERM exit code: null
```

After:

```
# node --test --test-timeout=10000 exits cleanly:
✗ ws client receives NOTE_INIT type on connect (10050ms)
  Error: Test timed out after 10000ms
ℹ tests 4, fail 1
```

The heal loop now has a clear target.

## Lesson from example runs

The three examples collectively produced several systemic findings that are now
recorded in NEXT.md as candidates. The test-timeout one is the most mechanical
to fix and has the clearest cost/benefit ratio: zero interface change, one runner
line changed, every future example gets the safety net automatically.

The others — session-2 file protection, async Express route sensor, ANSI-aware
truncation — require more design work and are parked as candidates for later phases.
