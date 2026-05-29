# Phase 45: Terminal Turn UI

## Goal

Add a zero-dependency terminal turn UI as a second user-facing channel over the
same run/session engine:

- `kodr tui`
- `kodr tui --session <id>`
- `kodr tui --continue`

The TUI should support simple user/assistant turns and slash commands without
becoming a separate execution path.

## Design

### Channels

Introduce a small channel boundary so request handling does not belong only to
the command line parser.

Kodr has one channel today:

- command line: one request in, one response out

This phase adds a second channel:

- terminal UI: repeated user turns, assistant responses, slash commands

Future channels, such as a web UI, should be able to reuse the same request
shape and run/session service instead of copying CLI behavior.

### Request Flow

- Extract shared run/session request handling behind a central channel-facing
  function.
- Keep command-line behavior as one channel adapter.
- Add the TUI as another channel adapter.
- Ensure both channels write the same artifacts: `summary.json`,
  `conversation.json`, `raw-response.json`, `writes.json`, `tests.json`, and
  session metadata.
- Do not create a separate TUI storage model.

### Terminal UI

Use Node.js built-ins only, likely `node:readline/promises`.

The first implementation should be a line-oriented interface, not a curses UI:

```text
kodr 0.0.44
session: new

user> add a small parser
assistant> ...
user> /status
assistant> session=... model=... apply=dry-run tools=off
user> /quit
```

Supported slash commands:

- `/help` — show TUI commands.
- `/quit` or `/exit` — leave the TUI.
- `/status` — show session id, last run dir, model, provider, apply mode, tools
  mode, and budgets.
- `/sessions` — list sessions using the phase 44 browsing logic.
- `/show <id>` — show a session conversation using the phase 44 browsing logic.
- `/use <id>` — continue a specific session for future turns.
- `/new` — start a fresh session.
- `/apply on|off` — toggle `--yes` behavior.
- `/tools on|off` — toggle native tool calls.
- `/model <id>` — change the active model.

### Turn Behavior

- `kodr tui` starts a new session unless the user chooses one with `/use`.
- `kodr tui --session <id>` starts with that session selected.
- `kodr tui --continue` starts from the latest run, matching CLI continuation
  semantics.
- Each normal input line becomes one user turn.
- After a successful turn, the TUI updates its active session id and last run
  dir from the run summary.
- Dry-run remains the default.
- The assistant output should be concise: proposal messages, write/test summary,
  response text when there is no proposal, run dir, and current session id.

## Risks

- Duplicating CLI run logic inside the TUI would create drift. The TUI must call
  shared channel/run functions.
- Long local model calls need visible progress text before the request starts,
  even if streaming is not enabled.
- Slash commands should never be sent to the model by accident.
- Session continuation should preserve the existing transcript semantics from
  phases 42 and 43.

## Done Criteria

- [ ] Add `kodr tui`, `kodr tui --session <id>`, and `kodr tui --continue`.
- [ ] Add a central channel-facing request function used by both CLI and TUI.
- [ ] Implement the basic readline loop with slash commands.
- [ ] Keep normal turns artifact-compatible with `kodr run`.
- [ ] Tests cover argument parsing, slash command handling, channel routing, and
      session selection.
- [ ] Document the TUI in `README.md`.
- [ ] Record decisions and any failures.
- [ ] Blog post.
