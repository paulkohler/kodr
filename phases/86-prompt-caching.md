# Phase 86: Prompt Caching

## Goal

Add provider-aware prompt caching support for remote models, starting with
Anthropic-style explicit cache control and cache usage reporting for all
providers that return cache token counters.

Prompt caching should reduce repeated remote-model prompt cost and latency
without changing local model behavior.

## Context

Kodr already has a useful prompt shape for caching:

- normal runs send the system prompt as the first chat message
- the user prompt follows after the system prompt
- session continuation freezes the parent system prompt from the prior
  transcript
- subagent stages each have an isolated system prompt and model selection

Automatic prefix caching works only when the token stream at the start of the
request is identical. Kodr's first message currently includes both stable
harness instructions and dynamic project context, so cache hits will depend on
whether the packed context, AGENTS.md, memory, skills, and file map remain
unchanged.

Anthropic's current automatic prompt cache path can be enabled with root-level
cache control:

```json
{
  "cache_control": { "type": "ephemeral" }
}
```

That means Kodr does not need to choose a message or content-block breakpoint
for the first implementation.

## User Surface

Add optional flags:

```sh
kodr run -p "task" --openrouter --model anthropic/claude-sonnet-4.5
kodr run -p "task" --model openrouter/anthropic/claude-sonnet-4.5
kodr run -p "task" --prompt-cache off
kodr run -p "task" --prompt-cache auto
```

Proposed flags:

- `--prompt-cache auto|off`: default `auto`.
- `--prompt-cache-ttl <ttl>`: reserved for providers that support TTL. Do not
  send it unless a provider/model adapter explicitly supports it.

No flag should be required for the default remote Anthropic case. If the model
name identifies Anthropic and prompt caching is not disabled, Kodr should add
the root cache control automatically.

## Detection Rules

Use model-name and capability detection rather than provider-only detection.
This avoids coupling prompt cache behavior to OpenRouter.

Initial helpers:

```js
function isAnthropicModel(model) {
  return model.includes('anthropic/');
}

function isOllamaCloudModel(model) {
  return model.endsWith(':cloud');
}

function isLocalCostFreeProvider(options, model) {
  if (options.provider === 'ollama' && isOllamaCloudModel(model)) {
    return false;
  }
  return ['local', 'lmstudio', 'ollama'].includes(options.provider);
}
```

Initial cache modes:

- Anthropic model name: send root `cache_control`.
- OpenAI/GPT models: report-only; implicit provider caching.
- DeepSeek models: report-only; implicit provider caching.
- Gemini models: report-only in this phase.
- Qwen/Alibaba models: report-only in this phase.
- Ollama local models: no cache controls and cost stays zero.
- Ollama `:cloud` models: remote for cost/reporting purposes, but no cache
  controls unless a later adapter supports that model.

## Request Transform

Add a request transformer near `createChatCompletion()` so all standard,
staged, subagent, repair, and future HTTP/TUI calls share one behavior.

Rules:

- Do not mutate the caller's original request object.
- Do not send cache fields to local-only models.
- Do not send cache fields when `--prompt-cache off`.
- If `model.includes('anthropic/')`, add:

```json
{
  "cache_control": { "type": "ephemeral" }
}
```

- Preserve structured output fields, tools, streaming flags, and
  `max_thinking_tokens`.
- Record the transformed request in `raw-request.json`.

Do not implement Anthropic content-block cache breakpoints in this phase.
Root-level cache control is the first pass.

## Usage Reporting

Normalize cache token fields into Kodr summaries while preserving raw usage.

Add normalized fields when present:

```json
{
  "cacheReadTokens": 0,
  "cacheWriteTokens": 0,
  "cachedTokens": 0
}
```

Provider mappings:

- OpenAI/OpenRouter style:
  - `usage.prompt_tokens_details.cached_tokens` -> `cachedTokens`
  - `usage.prompt_tokens_details.cache_write_tokens` -> `cacheWriteTokens`
- Anthropic style:
  - `usage.cache_read_input_tokens` -> `cacheReadTokens`
  - `usage.cache_creation_input_tokens` -> `cacheWriteTokens`
  - `usage.input_tokens` can be treated as prompt/input tokens when
    `prompt_tokens` is absent
  - `usage.output_tokens` can be treated as completion tokens when
    `completion_tokens` is absent
- Keep OpenRouter `usage.cost` authoritative for cost.
- Local `lmstudio`, `local`, and non-cloud `ollama` providers remain cost zero
  even if a server returns cost-like fields.
- Do not zero cost for Ollama models ending in `:cloud`.

Render cache details in human output when non-zero:

```text
Tokens: 120,000 (prompt 100,000 / completion 20,000, cached 80,000, cache write 20,000)
```

Keep the line compact; omit zero counters.

## Prompt Stability Review

Add tests and notes around the current prompt prefix:

- fresh runs begin with a `system` message
- continued sessions preserve the original system message exactly
- subagent stages get cache handling through their selected model options
- dynamic workspace context can still invalidate prefix cache hits

Do not refactor context packing in this phase. A later phase can split the
system prompt into stable harness contract and dynamic workspace context if
cache hit rates are poor.

## Implementation Plan

1. Add prompt-cache CLI parsing with default `auto`.
2. Add model capability helpers for Anthropic and Ollama cloud model names.
3. Add a request transformer in the model client path.
4. Ensure raw request artifacts contain the transformed request body.
5. Extend usage normalization for cache read/write/cached counters and
   Anthropic `input_tokens`/`output_tokens`.
6. Update loop-budget usage merging so cache counters survive staged,
   subagent, and repair flows.
7. Update human usage rendering to include non-zero cache counters.
8. Add tests for Anthropic root cache control, local no-op behavior,
   OpenAI-style report-only behavior, Ollama `:cloud` cost behavior, and usage
   normalization.
9. Update `usage.md`.
10. Record decisions/failures and write the blog post.

## Non-Goals

- No provider SDK dependency.
- No Anthropic content-block breakpoint selection.
- No Gemini explicit cached-content lifecycle.
- No Alibaba/Qwen explicit cache marker support.
- No cache persistence managed by Kodr.
- No attempt to guarantee a cache hit.
- No prompt-layout refactor beyond documenting current stability properties.

## Open Questions

- Should `--prompt-cache-ttl` be accepted but ignored until a provider adapter
  supports it, or rejected unless supported?
- Should OpenRouter Anthropic requests always receive root `cache_control`, or
  should Kodr only send it when the selected model's capabilities registry says
  it is accepted?
- Should prompt cache metrics be included in `kodr session list` or only in run
  summaries?
- Should a later phase split `systemPrompt` into stable and dynamic sections to
  improve automatic prefix hit rates?

## Done Criteria

- [x] CLI parses `--prompt-cache auto|off`.
- [x] Anthropic model names receive root `cache_control` when caching is auto.
- [x] Local and non-cloud Ollama models do not receive cache controls.
- [x] OpenAI/DeepSeek/Gemini/Qwen remain report-only in this phase.
- [x] Ollama `:cloud` models are treated as remote for cost/reporting
      assumptions.
- [x] Raw request artifacts show the transformed request.
- [x] Usage normalization records cache read/write/cached counters.
- [x] Human output reports non-zero cache counters compactly.
- [x] Tests cover request transforms and usage mappings.
- [x] Current prompt prefix stability is documented in tests or notes.
- [x] Update `usage.md`.
- [x] Record decisions and failures.
- [x] Blog post.
- [x] Mark roadmap complete and commit.
