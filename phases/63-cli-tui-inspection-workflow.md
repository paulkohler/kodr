# Phase 63: CLI/TUI Inspection Workflow

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
matching the `inspect_context` tool dropped in Phase 62.

Keep output line-oriented and dependency-free. Reuse the same built-in
`inspectWorkspace` / `findReferences` engine as Phase 62 so model and human
surfaces stay consistent.

## Non-Goals

- No full-screen TUI renderer.
- No web UI.
- No model call required for inspection commands.

## Done Criteria

- [x] Add file-focused CLI inspection (`--file`).
- [x] Add TUI `/inspect` and `/refs` slash commands.
- [x] Keep slash commands out of model channels.
- [x] Add tests for CLI and TUI inspection workflows.
- [x] Record decisions and any failures.
- [x] Blog post.
- [x] Mark roadmap complete and commit.

## Result

`kodr inspect --file <path>` now filters structural output to a single jailed
workspace file. The terminal UI has `/inspect <symbol-or-file>` and
`/refs <symbol>` slash commands backed by a shared inspection channel request,
so they do not create model turns. CLI and TUI rendering share the same
line-oriented inspection output helpers.
