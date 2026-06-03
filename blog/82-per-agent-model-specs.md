# Phase 82: Per-Agent Model Specs

Subagent orchestration made the next model-selection problem obvious. The
planner, implementer, and reviewer do different work, so they should not always
be forced onto the same model.

Phase 82 adds provider/model specs and repeatable subagent overrides:

```sh
kodr run -p "task" --subagent-stages \
  --model lmstudio/qwen/qwen3.6-35b-a3b \
  --agent-model planner=openrouter/anthropic/claude-opus \
  --agent-model reviewer=lmstudio/nvidia/nemotron-3-nano-omni
```

The parser splits only on the first slash. That keeps provider routing
unambiguous while allowing provider-native model ids to keep their own slashes.

Existing `--model` and `--openrouter` usage stays compatible. The new syntax is
an additional layer, not a flag migration.

One usability edge appeared immediately in manual testing: `--agent-model` is a
subagent-stage feature. If a run omits `--subagent-stages`, Kodr now warns that
the overrides are inactive and the primary `--model` is the only model that will
be called.

A second Nemotron run showed the next boundary. The OpenRouter planner did the
right work, but the local implementer returned syntactically valid JSON with the
wrong Kodr proposal schema. Kodr now sends structured-output `response_format`
schemas for proposal and review turns, so local models get server-side shape
pressure instead of prompt-only JSON instructions.

The same run also exposed long reasoning-token stalls. Kodr added an opt-in
`--max-thinking-tokens` flag that passes `max_thinking_tokens` for reasoning
models and servers that support that request field.
