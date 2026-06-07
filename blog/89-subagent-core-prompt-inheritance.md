# Phase 89: Subagent Core Prompt Inheritance

The subagent pipeline had a subtle mismatch: the API request included tool
schemas, but the subagent system prompt did not inherit Kodr's standard harness
preamble.

That meant the planner could call `list_files` and `read_file`, the implementer
could call `run_command`, and the reviewer could inspect files, but their system
messages only described the orchestration role. They were missing the shared
Kodr identity, untrusted-input warning, proposal envelope, AGENTS.md handling,
memory and skill guidance, and exact tool-name discipline from the standard run
path.

Phase 89 splits the reusable core prompt from workspace packing. Standard runs
keep their existing system prompt shape. Subagents now receive the same core
Kodr contract first, then the subagent roster, then a generated "Available
Tools" section, then the role-specific orchestration prompt.

The generated tool section matters for small local models. It names the exact
tools available to the current stage and warns against invented names such as
`read` or `write_file`. Planner and reviewer see `list_files` and `read_file`.
The implementer also sees `run_command`.

The fix deliberately keeps bulky workspace context out of the subagent system
prompt. File maps, plans, write manifests, and verification handoffs remain in
the user message for each stage. AGENTS.md and memory content also stay in the
workspace handoff, while the system prompt carries the precedence and safety
rules for how to treat them.

The lesson is that tool schemas are not enough. The model needs an accurate
contract in the same place as its highest-priority behavior instructions, and
that contract has to match the real tools the harness registered.
