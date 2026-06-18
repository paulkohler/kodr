# Phase 205 — Thinking Model Profile Defaults

## Motivation

During Phase 204 example runs with `qwen/qwen3.6-35b-a3b`, kodr returned "POST
/chat/completions did not return a usable assistant message" consistently. Root
cause: qwen3.6 is a reasoning/thinking model. Without `max_thinking_tokens`:

1. **Streaming mode**: LM Studio ignores the thinking budget entirely — the model
   streams only `reasoning_content` chunks, never producing `delta.content`. The
   stream ends when LM Studio's internal token limit is hit, leaving
   `state.text = ''`. `firstAssistantMessage` returns `''` (falsy) → throw.

2. **Non-streaming mode**: `max_thinking_tokens` IS honored. With `max_tokens`
   unset, LM Studio uses a small default — the model exhausts all of it on
   reasoning, leaving no budget for actual output.

The `--max-thinking-tokens` CLI flag already existed but had no profile default.
Using it via the CLI fixes case 2 but not case 1 — `max_thinking_tokens` is still
ignored in LM Studio's streaming mode.

The only fix that works for qwen3.6 on LM Studio: use non-streaming wire
(`--wire-no-stream`) together with `--max-thinking-tokens`. This combination
forces the server to honor the thinking budget before returning the response.

## What this phase adds

- `maxThinkingTokens` as a model profile field. `normalizeProfile` passes it
  through; `applyModelProfile` applies it unless `_maxThinkingTokensSet` is set
  (i.e., the user explicitly passed `--max-thinking-tokens`).

- `wireNoStream` as a model profile field. `normalizeProfile` normalises to
  boolean; `applyModelProfile` ORs it into options (profile `true` is not
  overridable by absence of a CLI flag, though explicit `--wire-no-stream` still
  works).

- `_maxThinkingTokensSet` tracking in `args.mjs` so the CLI flag can override the
  profile default.

- qwen3.6-35b-a3b profiles (both `local` and `lmstudio` providers) get
  `maxThinkingTokens: 4096` and `wireNoStream: true`.

## Done criteria

- [x] `normalizeProfile` passes `maxThinkingTokens` and `wireNoStream` through.
- [x] `applyModelProfileDefaults` applies `maxThinkingTokens` from profile when
      `_maxThinkingTokensSet` is not set.
- [x] `applyModelProfileDefaults` sets `wireNoStream: true` when profile declares
      it.
- [x] `--max-thinking-tokens` CLI flag sets `_maxThinkingTokensSet = true`.
- [x] qwen/qwen3.6-35b-a3b profiles include `maxThinkingTokens: 4096` and
      `wireNoStream: true`.
- [x] 4 new tests in `test/model-profiles.test.mjs`.
- [x] `npm run format` and `npm run check` pass.
- [x] Committed.
