# Phase 46: TUI Apply Review

## Goal

Make `kodr tui` safer for coding work by adding an explicit review step for
model-proposed writes.

Today, the TUI can toggle `/apply on|off`, but that is still CLI-shaped. A
terminal turn with proposed writes should leave the user in a pending review
state where they can inspect, accept, reject, or test the proposal without
turning future model prompts into apply mode.

## Design

### Pending Review State

When a TUI turn returns proposed writes in dry-run mode:

- Store the run result as `state.pendingReview`.
- Print a compact review summary:
  - run dir
  - session id
  - proposed write count
  - path/status lines
  - any model proposal messages
  - available review commands

### Slash Commands

Add review commands:

- `/accept` — re-run the same user prompt against the active session with apply
  enabled, then clear pending review on success.
- `/reject` — discard the pending review without applying writes.
- `/test` — run the configured test command against the pending run when a test
  command is available, or show a clear message when none is configured.
- `/review` — reprint the pending review summary.

The first implementation may use re-run-to-apply rather than applying a stored
proposal artifact directly. That keeps all writes flowing through the existing
`kodr run --yes` safety path.

### Safety

- Slash review commands must never be sent to the model.
- `/accept` must only operate on the current pending review.
- A new normal user turn should replace or clear the pending review only after
  warning in the TUI output.
- Dry-run remains the default.

## Done Criteria

- [ ] TUI stores pending dry-run proposals with writes.
- [ ] `/review`, `/accept`, `/reject`, and `/test` are implemented.
- [ ] `/accept` applies through the shared run-turn channel.
- [ ] Tests cover pending review state and slash command routing.
- [ ] README documents the review commands.
- [ ] Record decisions and any failures.
- [ ] Blog post.
