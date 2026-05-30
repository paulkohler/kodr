# Phase 56: CLI/TUI Inspection Workflow

## Goal

Make inspection useful to humans, not only model context assembly.

Add CLI and TUI affordances for exploring symbols, references, files, and compact
inspection context.

## Design

Extend the inspection surface with commands such as:

- `kodr inspect --file src/app.mjs`
- `kodr inspect --symbol runPrompt`
- TUI `/inspect symbol`
- TUI `/refs symbol`
- TUI `/context symbol`

Keep output line-oriented and dependency-free.

## Non-Goals

- No full-screen TUI renderer.
- No web UI.
- No model call required for inspection commands.

## Done Criteria

- [ ] Add file-focused CLI inspection.
- [ ] Add TUI slash commands for inspection and references.
- [ ] Keep slash commands out of model channels.
- [ ] Add tests for CLI and TUI inspection workflows.
- [ ] Record decisions and any failures.
- [ ] Blog post.
- [ ] Mark roadmap complete and commit.
