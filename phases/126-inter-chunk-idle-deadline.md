# Phase 126 — Inter-Chunk Idle Deadline

## Motivation

Phase 113 bounded **time-to-first-token**: if no SSE chunk arrives within
`firstTokenTimeoutMs`, the request aborts and retries once. But that deadline
only governs the read *before the first byte*. Once streaming begins, the read
loop falls back to a bare `await reader.read()` with no per-read bound — so a
stream that goes silent **mid-response** is governed only by the overall
`timeoutMs`. gemma-4's phase-113 validation stall did exactly this: it received a
first chunk on retry, then hung for the remaining ~480s before the overall
timeout fired. Eight minutes of dead air that should have failed in seconds.

This phase adds an inter-chunk idle deadline: once streaming has started, no SSE
data for `idleTimeoutMs` fails the turn fast with a distinct error.

Evidence: `process/failures.jsonl` gemma validation stalls;
`src/model-client.mjs` `readServerSentEvents` (first-token-only deadline).

## Design principles

1. **Distinct, fail-fast, no retry.** `InterChunkIdleTimeoutError` is separate
   from `FirstTokenTimeoutError`. The first token already arrived and partial
   content was generated, so a blind retry would restart generation and risk
   double work — the idle timeout propagates and fails the turn with a clear
   signal instead.
2. **Rolling deadline.** The idle deadline resets on every read return, so it
   measures the gap *since the last chunk*, not a fixed budget from stream start.
3. **Unify, don't bolt on.** The pre-first-token and post-first-token reads
   become one deadline-raced read with the active deadline/error chosen per
   iteration — less duplication than the old two-branch loop, plus the new
   guarantee.

## Work items

### C1 — `InterChunkIdleTimeoutError` + rolling deadline

`readServerSentEvents` takes `idleTimeoutMs`. Each loop iteration picks the
active deadline: the fixed first-token deadline before the first byte, else
`Date.now() + idleTimeoutMs`. The read races a timeout; on expiry it cancels the
reader and throws the matching error. `createChatCompletion` keeps its
single-retry catch for `FirstTokenTimeoutError` only — the idle error is not
caught there and propagates.

### C2 — Option + flag

`options.idleTimeoutMs` (default `''` → `DEFAULT_IDLE_TIMEOUT_MS` = 120000), set
by `--idle-timeout-ms N`. Help text documents that it catches mid-stream stalls
the first-token deadline cannot.

### C3 — Test support

`startFakeModelServer` gains `streamThenStall`: send the given SSE chunk(s),
flush, then hold the socket open silently — the mid-stream stall the deadline
must catch.

## Testing

- A `streamThenStall` response with a small `idleTimeoutMs` throws
  `InterChunkIdleTimeoutError` (message mentions "went silent", correct
  `timeoutMs`).
- A normal stream completing within the idle window does not fire.
- Live: a normal gpt-oss streamed run completes end-to-end through the rewritten
  read loop (no regression).
- Full suite, format, check green.

## Done criteria

- [x] C1: rolling idle deadline + `InterChunkIdleTimeoutError`; unified read loop.
- [x] C2: `--idle-timeout-ms` option + help.
- [x] C3: `streamThenStall` fake-server capability.
- [x] Tests (stall fires, normal completes); live no-regression run.
- [x] `process/decisions.jsonl` updated.
- [x] Blog post `blog/126-inter-chunk-idle-deadline.md`.
- [x] NEXT.md revised; version bumped to 0.0.126; suite green; committed.
