# Phase 58: Inspector Tool Calls

## Goal

Expose code inspection as bounded model tools so tool-mode runs can navigate a
workspace structurally before editing.

## Design

Add tools backed by the structural index:

- `inspect_symbols`
- `inspect_file`
- `find_references`
- `inspect_context`

The tools should be read-only, jailed to the workspace, and return compact
results suitable for model use.

## Non-Goals

- No write tools in this phase.
- No external inspector registry dependency.
- No automatic model context replacement.

## Done Criteria

- [ ] Add read-only inspector tools to the built-in tool registry.
- [ ] Return compact, bounded JSON results.
- [ ] Enforce workspace jails and output limits.
- [ ] Add tests for each tool.
- [ ] Add prompt/system guidance for using inspector tools.
- [ ] Record decisions and any failures.
- [ ] Blog post.
- [ ] Mark roadmap complete and commit.
