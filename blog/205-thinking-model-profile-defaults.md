# Phase 205: Thinking Model Profile Defaults

## The problem

Running example tests in Phase 204, every attempt with `qwen/qwen3.6-35b-a3b`
returned:

```
Model run failed: POST /chat/completions did not return a usable assistant message
```

The `raw-response.json` showed `{"responses": []}` — the model request
"succeeded" at the HTTP level but produced no usable content.

## Root cause

qwen3.6-35b-a3b is a thinking model. It separates reasoning from output:
reasoning arrives in `delta.reasoning_content` SSE chunks, the actual response
in `delta.content` chunks.

Without a thinking budget (`max_thinking_tokens`), the model reasons
indefinitely. In LM Studio:

- **Streaming mode**: the model streams `reasoning_content` forever until it hits
  LM Studio's internal token limit. No `delta.content` is ever emitted. The
  reconstructed `message.content` is `''`, which is falsy — kodr throws
  "did not return a usable assistant message".

- **Non-streaming mode**: `max_thinking_tokens` IS honored. With no `max_tokens`
  set, LM Studio uses a small default (≈4096 tokens). The model exhausts
  all of it on reasoning, producing zero content tokens.

The `--max-thinking-tokens` CLI flag already existed but had no effect in
streaming mode — LM Studio simply ignores it there.

```
# Manual confirmation:
curl -X POST http://localhost:1234/v1/chat/completions \
  -d '{"model":"qwen/qwen3.6-35b-a3b","stream":true,"max_thinking_tokens":2000,...}'
# Result: 20,983 reasoning_content chunks, 0 content chunks
```

The same request with `"stream":false` produced 5,457 chars of content with
`finish_reason:"stop"`.

## The fix

Two new profile fields:

- **`maxThinkingTokens`** — passes `max_thinking_tokens` to the server, limiting
  reasoning budget. Only effective in non-streaming mode (LM Studio bug), but
  combined with `wireNoStream` this is sufficient.

- **`wireNoStream`** — forces non-streaming HTTP. The kodr streaming path was
  previously the only route (added in the LM Studio hang fix, phase 74); this
  flag provides a safe profile-level escape for models where streaming is broken.

The qwen3.6-35b-a3b profiles (both `local` and `lmstudio` providers) now default
to `maxThinkingTokens: 4096` and `wireNoStream: true`. With these, the thinking
model reasons up to ~4096 tokens and then produces content before returning.

`_maxThinkingTokensSet` tracking was added to `args.mjs` so `--max-thinking-tokens N`
on the CLI still overrides the profile.

## What changed

- `src/model-profiles.mjs`: `normalizeProfile` passes through `maxThinkingTokens`
  and `wireNoStream`; `applyModelProfileDefaults` applies both from the profile.
  Both qwen3.6 profiles set the new fields.
- `src/cli/args.mjs`: `--max-thinking-tokens` now sets `_maxThinkingTokensSet`
  so the CLI override wins over the profile default.
- `src/model-client.mjs`: comment updated — `wireNoStream` is no longer debug-only.
- `test/model-profiles.test.mjs`: 4 new tests (profile has the fields, profile
  default applies, CLI override works, non-thinking profile has `wireNoStream:
  false`).

## Lesson

Thinking models need two things to work in non-streaming mode on LM Studio:
`max_thinking_tokens` (to leave room for output) and `stream:false` (because
LM Studio ignores `max_thinking_tokens` in streaming mode). Neither alone is
enough. Both are required.
