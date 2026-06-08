# Phase 63: CLI/TUI Inspection Workflow

Phase 62 made structural inspection available to the model as bounded tools.
Phase 63 makes the same inspection useful to the human driving Kodr.

The CLI already had `kodr inspect --symbol`. This phase adds file-focused
inspection:

```sh
kodr inspect --file src/app.mjs
```

The file path is jailed to the workspace, then the structural index is filtered
to that file. JSON output stays available, so inspection can still be scripted
or used by tests.

The TUI now has two local slash commands:

```text
/inspect runPrompt
/inspect src/app.mjs
/refs runPrompt
```

These commands are deliberately not model turns. They route through a local
`inspect` channel request, render line-oriented output, and return immediately.
That preserves the channel boundary added earlier: CLI, TUI, and future web
surfaces can all ask the harness for deterministic information without
duplicating command logic or sending accidental prompts.

The important product choice was to avoid a `/context` command. It would expose
the heavy packed context blob and encourage humans to inspect the same token
budget artifact that models consume. The better human affordance is narrower:
symbols, file structure, and references.

Tests cover the CLI `--file` filter, path traversal rejection, TUI `/inspect`
and `/refs`, and the fact that those slash commands issue inspection requests
rather than `run-turn` requests.
