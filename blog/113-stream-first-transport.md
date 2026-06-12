# Phase 113 — Stream-First Transport

Four dogfood runs died as 600-second zero-byte timeouts. Then one curl command solved the mystery in under three seconds.

## The root cause

The identical request body — same model, same tools array, same messages — returned a first token in under two seconds when sent with `stream: true`. It hung indefinitely with `stream: false`.

kodr was coupling the wire protocol to display state. The resolution path in `app.mjs` was:

```
options.stream === 'auto' → stdout.isTTY === true && !options.json
```

Interactive terminal sessions streamed. Every other invocation — piped, redirected, `--json`, served, watched, subagent-driven — sent the fragile non-streaming request. All four stalls happened in non-TTY runs.

## The fix was small

`createChatCompletion` now always sends `stream: true` plus `stream_options: { include_usage: true }`. The SSE parser was already complete — it reassembles tool-call fragments across chunks and reads the final usage event. `options.stream` (true/false/'auto') now controls only whether tokens render incrementally to the terminal.

The only way to get a non-streaming wire request is the explicit `--wire-no-stream` flag, documented as a debugging escape hatch for servers that can't stream. It is never chosen automatically.

## The first-token deadline

Evidence from three separate incidents: an immediate retry succeeded every time. The problem was not model capacity — it was LM Studio entering a degraded slot state after abandoned constrained-decode generations. A fresh connection recovered instantly.

So phase 113 adds a first-token deadline: if no SSE data arrives within 120 seconds (the default, overridable via `--first-token-timeout-ms` or model profile), the request throws `FirstTokenTimeoutError` and retries exactly once. A second stall fails the run with a distinct error message naming what happened and how to adjust the timeout.

The implementation was trickier than expected.

## The unref trap

The first-token timer lives inside a `Promise.race` between `reader.read()` and a `setTimeout`. When the server stalls after sending HTTP 200 headers, `reader.read()` hangs on I/O. The plan: the timer fires, rejects the race, and `FirstTokenTimeoutError` is thrown.

It didn't work in tests. The symptom: the overall 5000ms `timeoutMs` fired instead of the 40ms first-token timer.

The cause: `setTimeout(...).unref()`. In test environments where the stall server holds the only I/O event, an unref-ed timer can be silently skipped — the event loop sees "only I/O + unref-ed timers" and exits rather than waiting. Removing `.unref()` from the first-token timer fixed it immediately.

The overall request timer in `requestWithNodeHttp` stays unref-ed. It is bounded by the underlying I/O: when headers arrive, the incoming stream's `close` event clears the timer.

## The empty-chunk problem

When a server calls `response.flushHeaders()` without any body, Node.js may deliver a zero-byte chunk via `Readable.toWeb`. If the code counted this as "first token received," the deadline would never fire for a true stall.

Fix: only set `firstChunkSeen` when `value.length > 0` or the stream ends (`done === true`). The deadline is stored as an absolute timestamp (`Date.now() + firstTokenTimeoutMs`) so multiple empty-chunk iterations don't erode the budget.

## Test infrastructure: auto-SSE conversion

Before phase 113, the fake model server returned plain JSON chat responses. The `stream: false` wire path parsed these correctly. After the change, every call goes through the SSE parser — which expects `text/event-stream` content.

Rather than updating 65+ test files individually, the fake server now auto-converts JSON chat completion responses to SSE format when the request body includes `stream: true`. Tests that already supply explicit SSE bodies are served as-is. Tests using `--wire-no-stream` bypass conversion. The existing test corpus continued passing without modification.

## Transport forensics

Each model call now returns a `transport` object alongside `body`:
- `wire`: `'stream'` or `'none'` (wireNoStream path)
- `timeToFirstTokenMs`: milliseconds to first SSE chunk
- `firstTokenRetries`: count of stall retries

The completion and tool-calls loops aggregate these per-turn facts into a run-level summary, which lands in `summary.json`. `kodr why`'s Model Call step surfaces them: "first token after 1.2s; 1 stall retry."

## What was left out

The live two-model validation — streaming redirected runs against `google/gemma-4-26b-a4b` and `openai/gpt-oss-20b` in sequence — runs separately after the phase commit. The box is intentionally unchecked.
