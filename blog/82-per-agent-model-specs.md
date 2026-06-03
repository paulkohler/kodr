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
