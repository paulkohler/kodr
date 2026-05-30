# Phase 52: Inspection-Aware Context Packing

## Goal

Use the structural code index to pack smaller, more relevant context for model
runs.

The first pass should prove that inspection can improve context selection
without removing the existing whole-file context path.

## Design

Add an inspection-aware context mode that can select:

- matching symbol definitions
- nearby imports
- likely references
- related test chunks
- compact file summaries when full files are too large

Start conservatively. Prefer an explicit flag or a narrow integration point
before changing the default behavior for every run.

## Non-Goals

- No external inspector plugins.
- No LSP integration.
- No semantic ranking model.
- No removal of existing context packing.

## Done Criteria

- [ ] Add an explicit inspection-aware context path.
- [ ] Use structural symbols and references to select chunks.
- [ ] Include related tests when discoverable.
- [ ] Preserve existing full-file context behavior.
- [ ] Add tests for chunk selection and fallback behavior.
- [ ] Record decisions and any failures.
- [ ] Blog post or update the inspection design note.
- [ ] Mark roadmap complete and commit.
