# Phase 67: Interactive TUI Permission Prompts

## Goal

Make permission-gated actions visible and controllable in `kodr tui`.

Kodr already has policy foundations, but install, write, git, and future skill
execution flows need a clear interactive approval path. This moves the TUI
closer to a real coding harness instead of a thin chat wrapper.

## Design

Route permission requests through the shared channel/request handling layer so
CLI, TUI, and later web surfaces use the same approval contract.

At minimum, support:

- allow once
- deny once
- show the requested action and reason
- return structured approval status to the caller

Keep the first pass dependency-free and line-oriented.

## Non-Goals

- No persistent trust store yet.
- No full policy editor UI.
- No broad shell permission expansion.

## Done Criteria

- [ ] Permission prompts flow through the shared channel layer.
- [ ] TUI can approve or deny a gated action.
- [ ] CLI behavior remains compatible.
- [ ] Add tests for approved and denied actions.
- [ ] Record decisions and any failures.
- [ ] Blog post.
- [ ] Mark roadmap complete and commit.
