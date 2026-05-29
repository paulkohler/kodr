# Phase 45: Terminal Turn UI

Phase 45 adds `kodr tui`, a small line-oriented terminal interface for taking repeated user/assistant turns. It is deliberately not a full terminal application yet: no curses layout, no dependency, no separate persistence model.

The important design point is the channel boundary. Until now, Kodr had one user-facing channel: command line input. The terminal UI adds a second channel, and a future web UI would be a third. Those channels should not each learn how to run prompts, continue sessions, list sessions, and write artifacts. They should adapt user input into the same central request shape.

The new TUI therefore calls the same run/session handling used by `kodr run` and `kodr session`. Normal lines become run turns. Slash commands are handled locally and are never sent to the model. That gives the UI a small command language:

- `/sessions`
- `/show <id>`
- `/use <id>`
- `/new`
- `/apply on|off`
- `/tools on|off`
- `/model <id>`
- `/status`
- `/quit`

Dry-run remains the default. After each successful turn, the TUI updates its active session from the run summary, so follow-up turns continue the same artifact-backed conversation. `kodr tui --continue` starts from the latest run, while `kodr tui --session <id>` starts from a named session.

This phase keeps the interface plain on purpose. The value is not visual polish; it is proving that Kodr's request flow can support more than one channel without duplicating execution behavior.
