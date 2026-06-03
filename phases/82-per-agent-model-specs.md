# Phase 82: Per-Agent Model Specs

## Goal

Allow subagent stages to use different models and providers while preserving the
existing default model behavior.

This supports workflows such as local implementer/reviewer calls with a stronger
remote planner.

## Design

Add provider/model specs:

```text
lmstudio/qwen/qwen3.6-35b-a3b
lmstudio/nvidia/nemotron-3-nano-omni
openrouter/anthropic/claude-opus
```

Only the first slash separates provider from model id. The rest is passed
through as the provider-native model id.

Add repeatable `--agent-model agent=provider/model` for `planner`,
`implementer`, and `reviewer`.

Existing behavior remains compatible:

- Plain `--model qwen/qwen3.6-35b-a3b` still means the current provider.
- `--openrouter --model openai/gpt-4o-mini` still works.
- Agent overrides only affect `--subagent-stages`.

## Done Criteria

- [x] Add model spec parsing and resolution.
- [x] Add repeatable `--agent-model`.
- [x] Keep existing `--model` and `--openrouter` behavior compatible.
- [x] Subagent orchestration uses per-agent model options.
- [x] Subagent artifacts record model and provider per agent.
- [x] Tests cover parsing, mixed provider options, and subagent model routing.
- [x] Update usage docs, decisions, blog, roadmap, and version.
- [x] Run format, tests, and check.
- [x] Commit the phase.
