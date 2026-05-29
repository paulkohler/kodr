# Phase 49: Channel Contract Tests

## Goal

Harden the shared channel boundary introduced for CLI and TUI.

The point is to make future channels, such as a web UI, plug into the same
request handling without duplicating run/session behavior.

## Design

Add contract-style tests around the central channel handler:

- CLI and TUI run-turns produce equivalent artifact shapes.
- Session list/show requests are channel-safe and presentation-independent.
- Slash commands never enter model prompts.
- Channel requests reject unknown kinds clearly.
- Channel adapters do not mutate shared option templates unexpectedly.

## Done Criteria

- [x] Add channel contract tests independent of CLI/TUI presentation.
- [x] Cover artifact equivalence for CLI and TUI turns.
- [x] Cover unknown request rejection.
- [x] Cover option immutability or documented mutation behavior.
- [x] Record decisions and any failures.
- [x] Blog post.
