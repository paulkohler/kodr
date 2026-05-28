# Phase 39: Network And Streaming Hardening

## Goal

Close a set of correctness and security gaps found in a review of the existing
network and streaming paths. None of these change the happy-path local-model
flow, but each one is a latent bug or a footgun that bites under a realistic
condition (a redirecting URL, a streaming run, an explicit `--model`, a literal
`--`-prefixed value).

## Fixes

1. **SSRF via redirects (`src/tools.mjs`).** `fetch_url` validated the initial
   hostname against private ranges, but `fetch()` follows redirects by default.
   A public host could `30x` to `http://169.254.169.254/` (cloud metadata) or
   `http://127.0.0.1`, bypassing the guard. Switch to `redirect: 'manual'` and
   reject any 3xx response. No redirect is ever followed.

2. **`--stream` silently dropped tool calls (`src/model-client.mjs`).** The SSE
   reader only accumulated `delta.content`, so `--tools --stream` produced a
   synthesized response with no `tool_calls` and a forced `stop`. Accumulate
   `delta.tool_calls` fragments (merged by index) and surface them with a
   `tool_calls` finish reason so the streaming path matches the buffered path.

3. **`kodr run` required `GET /models` even with `--model` (`src/app.mjs`).**
   Servers that don't implement `/models` failed every run even when the model
   was named explicitly. Skip the discovery call when `--model` is set; keep it
   as a fallback only when no model was provided.

4. **`parseArgs` rejected valid values (`src/app.mjs`).** Value-bearing flags
   rejected any next token that was empty or started with `--`, so `-p ""` and
   `-p "--literal"` threw "requires a value". Consume the next token
   unconditionally; only error when there is no next token at all.

5. **Streaming discarded `usage` (`src/model-client.mjs`).** The SSE path never
   captured the usage chunk, so `--stream` runs could not enforce `--max-tokens`
   / `--max-cost-usd`. Request `stream_options: { include_usage: true }` and
   carry the final usage object into the synthesized response body.

## Done Criteria

- [x] `fetch_url` uses `redirect: 'manual'` and rejects 3xx responses.
- [x] SSE reader accumulates `delta.tool_calls` and exposes `tool_calls`.
- [x] Streaming response body carries `usage` when the server sends it.
- [x] `kodr run` skips `/models` discovery when `--model` is provided.
- [x] `parseArgs` consumes flag values that are empty or start with `--`.
- [x] Tests cover redirect rejection, streamed tool calls, streamed usage,
      model-discovery skipping, and the new arg parsing.
- [x] Record decisions and any failures.
- [x] Blog post.
