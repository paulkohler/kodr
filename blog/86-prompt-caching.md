# Phase 86: Prompt Caching

Phase 86 adds a conservative prompt-caching layer for remote models. The first
implementation optimizes for correctness and inspectability: Kodr sends explicit
cache control only where the model family is known to accept it, and otherwise
records cache usage when providers report it.

## Research Notes

Anthropic's current prompt caching path supports root-level cache control:

```json
{
  "cache_control": { "type": "ephemeral" }
}
```

That matters for Kodr because it avoids the fragile first-pass problem of
choosing a cache breakpoint inside OpenAI-compatible chat messages. We do not
need to split the system message, tool definitions, or content blocks yet.

OpenRouter's prompt-caching docs show provider-neutral cache accounting under
`usage.prompt_tokens_details`, including `cached_tokens` and
`cache_write_tokens`. OpenRouter also reports `usage.cost`, which remains the
authoritative billing value for Kodr.

OpenAI-style prompt caching is automatic. DeepSeek also has automatic context
caching. Gemini and Alibaba/Qwen have explicit cache mechanisms, but their
request shapes differ enough that Kodr should not guess at payload fields in
this phase. They are report-only until a provider-specific adapter is designed.

Ollama is no longer always local. Ollama documents cloud models, and model ids
such as `minimax-m3:cloud` make the remote path easy to detect. Kodr now keeps
normal Ollama local models cost-free, but does not automatically zero usage
cost for `:cloud` model ids.

References:

- Anthropic prompt caching:
  https://docs.anthropic.com/en/docs/build-with-claude/prompt-caching
- OpenRouter prompt caching:
  https://openrouter.ai/docs/features/prompt-caching
- Ollama cloud:
  https://docs.ollama.com/cloud
- Ollama `minimax-m3:cloud`:
  https://ollama.com/library/minimax-m3:cloud

## Implementation Shape

The implementation lives in the shared model-client request path. That keeps
normal runs, tool loops, staged execution, subagent orchestration, healing, CLI,
TUI, and future HTTP calls aligned.

`--prompt-cache` accepts:

- `auto` — the default
- `off` — no Kodr-added prompt cache request fields

When cache mode is `auto` and the model id contains `anthropic/`, Kodr adds
root-level `cache_control: { "type": "ephemeral" }` unless the provider/model is
local-cost-free. The detection is model-name based, not OpenRouter-specific, so
future Anthropic routes can reuse it.

Kodr does not add explicit cache controls for OpenAI, DeepSeek, Gemini, Qwen, or
Ollama cloud in this phase. Those are report-only paths.

## Usage Reporting

Kodr now normalizes cache counters into run summaries when providers return
them:

- `cachedTokens`
- `cacheReadTokens`
- `cacheWriteTokens`

Mappings:

- OpenRouter/OpenAI-compatible:
  `usage.prompt_tokens_details.cached_tokens` and
  `usage.prompt_tokens_details.cache_write_tokens`
- Anthropic-style:
  `usage.cache_read_input_tokens`,
  `usage.cache_creation_input_tokens`,
  `usage.input_tokens`, and `usage.output_tokens`

Human output includes cache details only when non-zero. Normal local runs do not
gain zero-valued cache fields in summaries or loop budget artifacts.

## Prompt Stability

Kodr already starts fresh runs with a `system` message and appends the user
message after it. Session continuation freezes the parent system prompt from the
prior transcript, which is good for provider prefix caches.

The weak spot is that the system prompt currently includes both stable harness
instructions and dynamic workspace context. Any changed file map, AGENTS.md,
memory block, loaded skill, or packed source file can alter the prefix and miss
the cache. That is acceptable for this phase. A later phase should split the
prompt into a more stable harness prefix and a dynamic project context section
if real cache hit rates are poor.

## Verification

- request-shaping tests confirm Anthropic model ids receive root cache control
  and local/disabled paths do not
- app tests confirm `raw-request.json` records the transformed request
- usage-normalizer tests cover OpenRouter-style and Anthropic-style cache
  counters
- Ollama `:cloud` model ids are treated as remote for cost assumptions
- focused app/model-client/usage tests passed
