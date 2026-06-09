# Phase 93: Persona From Skill

Replace hardcoded `prompts/orchestration-*.md` files with role skills loaded
from the builtin bundle, making personas data-driven.

## Solution

- `buildAgentSystemPrompt` tries `getBuiltinSkill('role:'+agentName).body` first
  and falls back to the prompt file for roles not yet in the bundle.
- `AGENTS` in `orchestration.mjs` and `model-specs.mjs` updated to include
  `file-author`, enabling `--agent-model file-author=provider/model`.
- `splitAgentDirectives` regex updated to include `file-author`.
- `renderAgentRoster` updated to describe all four agent stages.

## Done criteria

- [x] Planner, implementer, file-author, and reviewer system prompts use builtin
  skill bodies.
- [x] `--agent-model file-author=...` is accepted (model-specs AGENTS set).
- [x] `file-author:` directive prefix is recognised in user prompts.
- [x] Fallback to `prompts/orchestration-*.md` when role skill is missing.
- [x] All existing orchestration tests pass.
