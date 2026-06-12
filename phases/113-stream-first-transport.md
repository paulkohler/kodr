# Phase 113 — Stream-First Transport

## Motivation

Dogfooding rounds 2–3 produced four runs that died as 600-second zero-byte
timeouts. Round 3 root-caused all of them: the identical request body returns
a first token instantly with `stream: true` but hangs indefinitely with
`stream: false` on LM Studio (gemma-4 MLX; reproduced with curl both ways,
~90s+ vs instant). kodr picks the wire protocol from presentation state:
`options.stream === 'auto'` resolves to `io.stdout.isTTY === true &&
!options.json` (src/app.mjs ~1168). Interactive runs stream and work; every
redirected, piped, `--json`, served, watched, or subagent-driven run sends
the fragile non-streaming request and inherits the hang.

Transport reliability must not depend on whether a human is watching. The
SSE parser is already complete — it reassembles tool-call fragments and
requests a final usage chunk (`stream_options: { include_usage: true }`)
— so the non-streaming wire path buys nothing except exposure to the hang.

Evidence: `process/failures.jsonl` phases 112 and 113-dogfood;
`~/src/kodr-testing/phase-113/greenfield-logstats-1/run1.log` (stall) vs
`run2.log` (same task, `--stream`, success);
`~/src/kodr-testing/phase-112/gemma-smoke-3/` (two stalls, then success).

## Work items

### T1 — Always stream on the wire

`createChatCompletion` (src/model-client.mjs) always sends `stream: true` +
`stream_options: { include_usage: true }` and consumes the SSE response,
regardless of TTY, `--json`, or channel. `options.stream` (true/false/'auto')
becomes a *display* concern only: it controls whether tokens render
incrementally to the terminal, nothing about the wire. Keep one explicit
escape hatch for debugging servers that can't stream: `--wire-no-stream`
flag, surfaced in `--help`, never chosen automatically. Run artifacts
(`raw-request.json`) must record the body actually sent (`stream: true`).

Audit every call path inherits this: main run, tool-calls loop, forced final
turn, healing repair turns, E4 nudge, orchestration subagents
(planner/implementer/reviewer/file-author), compare, eval, bench, serve,
watch, TUI. None of these should be able to opt back into non-streaming
except via the explicit flag.

### T2 — First-token deadline

New `firstTokenTimeoutMs` (default 120000): the time allowed between sending
the request and receiving the first SSE chunk. Configurable per model profile
and via `--first-token-timeout-ms`. On expiry, abort with a distinct error
(e.g. `FirstTokenTimeoutError`) whose message says what happened and what to
do: `no first token after 120s (server stalled?) — retrying` /
`--first-token-timeout-ms to adjust`. The overall `timeoutMs` budget still
bounds the whole request. Once the first chunk arrives, the deadline is
satisfied (inter-token stalls remain governed by the overall timeout).

### T3 — One automatic retry on first-token timeout

Evidence across three incidents: an immediate retry succeeded every time.
On `FirstTokenTimeoutError`, retry the request exactly once (same body),
noting the retry in run output and artifacts. A second first-token timeout
fails the run with the distinct message. Never more than one retry — this
must not become a loop, and it must not retry on other error classes.

### T4 — Transport forensics

`summary.json` records transport facts: wire mode, `timeToFirstTokenMs` for
each model call (or per-turn in turn metadata where that exists), and
first-token retry count. `kodr why`'s Model Call step surfaces them
("first token after 1.2s; 1 stall retry"). The run-failure surface for a
double first-token timeout names the failure distinctly instead of a generic
timeout.

## Testing

- Fake-server tests: an endpoint that accepts the request and never sends a
  byte → `FirstTokenTimeoutError` fires at the configured deadline (use a
  short test value), exactly one retry happens, and a second stall fails the
  run with the distinct message. An endpoint that stalls once then streams on
  retry → run succeeds and records the retry.
- Wire-protocol assertions: a non-TTY, output-redirected invocation records
  `stream: true` in the request the fake server receives; `--wire-no-stream`
  records `stream: false`; display rendering on/off does not change the wire
  body.
- Regression: streamed tool-call fragment reassembly and usage-chunk
  accounting stay green (existing tests).
- Full suite, `npm run format`, `npm run check` green.
- Live validation (separate, sequential, after implementation): redirected
  (non-TTY) kodr runs against TWO models — `google/gemma-4-26b-a4b` and
  `openai/gpt-oss-20b` — succeed without `--stream`, flipping models via the
  LM Studio management API.

## Done criteria

- [x] T1: wire always streams; TTY/`--json` affect display only;
      `--wire-no-stream` is the only path to a non-streaming request.
- [x] T2: first-token deadline with profile/flag override and distinct error.
- [x] T3: exactly one automatic retry on first-token timeout, recorded.
- [x] T4: TTFT + retry count in summary and `kodr why`.
- [x] Fake-server stall tests pass; wire-protocol assertions pass.
- [x] `process/failures.jsonl` / `process/decisions.jsonl` updated.
- [x] Blog post `blog/113-stream-first-transport.md`.
- [x] NEXT.md entries shipped by this phase deleted (FIFO).
- [x] Version bumped to 0.0.113; suite green; committed.
- [ ] Live two-model validation green (run after the phase commit; findings
      recorded).
