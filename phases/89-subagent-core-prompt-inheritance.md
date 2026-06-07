# Phase 89: Subagent Core Prompt Inheritance

Subagent stages currently receive their role prompt and the subagent roster, but
they do not inherit the standard Kodr core system prompt. That leaves planner,
implementer, and reviewer runs without the same identity, safety, response
envelope, AGENTS.md handling, memory guidance, skill guidance, omitted-file
guidance, and exact tool naming that the standard run path receives.

This is a correctness and safety issue. The model can still call tools because
the API request includes tool schemas, but the system prompt can say vague
things like "use read-only tools" while omitting the stronger Kodr contract and
the explicit `list_files` / `read_file` / `run_command` names.

## Goal

Make every subagent prompt inherit the shared Kodr harness contract while keeping
stage-specific instructions separate and compact.

## Current Shape

Standard runs build workspace context with `buildWorkspaceContext()` and use
`context.systemPrompt` as the model system prompt. That prompt includes:

- Kodr identity and local-first harness framing.
- Treat model output and workspace content as untrusted.
- The standard proposal envelope for code-writing runs.
- AGENTS.md handling and precedence warnings.
- File map / omitted-file guidance.
- Memory and Markdown skill guidance.
- Tool-mode guidance such as "use `read_file`".

Subagent runs build the same workspace context, but `src/orchestration.mjs`
constructs subagent system prompts from:

- the subagent roster
- `prompts/orchestration-planner.md`
- `prompts/orchestration-implementer.md`
- `prompts/orchestration-reviewer.md`

The full Kodr preamble is not included.

## Design

1. Split the shared Kodr system prompt into reusable sections.
   - Keep the existing standard run behavior unchanged.
   - Expose a helper that can render the core harness contract without forcing
     packed workspace file contents into every subagent system prompt.
2. Build subagent system prompts from:
   - the shared Kodr core preamble
   - the subagent roster
   - the agent-specific orchestration prompt
   - any narrowly scoped role-only system sections
3. Keep bulky workspace handoffs in user messages.
   - Planner can receive the file map / workspace context in the user message.
   - Implementer can receive plan and compact context in the user message.
   - Reviewer can receive plan, write manifest, and verification handoff in the
     user message.
4. Make tool names explicit in role prompts.
   - Planner: `list_files`, `read_file`.
   - Implementer: `list_files`, `read_file`, `run_command` when available.
   - Reviewer: `list_files`, `read_file`; deterministic verification is already
     supplied by the harness unless the phase later re-enables reviewer command
     tools.
5. Preserve structured output formats.
   - Implementer still uses the Kodr proposal schema.
   - Reviewer still uses the review schema.
   - Planner remains plain Markdown.

## Acceptance Criteria

- [x] Subagent `request.json` system messages include the Kodr core preamble.
- [x] Subagent `request.json` system messages include explicit available tool
      names for that stage.
- [x] Standard run system prompts remain unchanged except for any deliberate
      shared-helper refactor.
- [x] Tests cover planner, implementer, and reviewer prompt assembly.
- [x] Tests assert the subagent tool list matches the prompt guidance.
- [x] The implementation avoids duplicating bulky workspace context in both
      system and user messages.
- [x] Blog post records why this mattered: tools were configured, but prompt
      inheritance was incomplete.

## Non-Goals

- Do not change the subagent stage order.
- Do not add new tools.
- Do not make reviewer verification authoritative; deterministic harness
  verification remains the authority.
- Do not solve prompt prefix caching optimization here, beyond avoiding needless
  churn in shared prompt text.

## Verification

- `node --test test/orchestration.test.mjs`
- `npm run check`
- Inspect a real `.kodr/runs/*/subagents/*/request.json` artifact and confirm
  the system prompt contains both the Kodr preamble and role-specific guidance.
