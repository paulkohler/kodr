# Phase 61: CLI/TUI Inspection Workflow

## Goal

Make inspection useful to humans, not only model context assembly.

Add CLI and TUI affordances for exploring symbols, references, and files. This is
human ergonomics, not new small-model capability, so it is the lowest-priority
phase in the 58–61 band — sequence it after the capability work lands.

## Design

`kodr inspect --symbol` and `--json` already exist (see `app.mjs`); this phase
only adds the missing pieces:

- `kodr inspect --file src/app.mjs` (file-focused CLI inspection)
- TUI `/inspect symbol`
- TUI `/refs symbol`

Do **not** add a `/context` slash command — it re-exposes the heavy context blob,
matching the `inspect_context` tool dropped in Phase 60.

Keep output line-oriented and dependency-free. Reuse the same built-in
`inspectWorkspace` / `findReferences` engine as Phase 60 so model and human
surfaces stay consistent.

## Non-Goals

- No full-screen TUI renderer.
- No web UI.
- No model call required for inspection commands.

## Done Criteria

- [ ] Add file-focused CLI inspection (`--file`).
- [ ] Add TUI `/inspect` and `/refs` slash commands.
- [ ] Keep slash commands out of model channels.
- [ ] Add tests for CLI and TUI inspection workflows.
- [ ] Record decisions and any failures.
- [ ] Blog post.
- [ ] Mark roadmap complete and commit.
