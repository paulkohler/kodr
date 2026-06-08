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

- [x] Permission prompts flow through the shared channel layer.
- [x] TUI can approve or deny a gated action.
- [x] CLI behavior remains compatible.
- [x] Add tests for approved and denied actions.
- [x] Record decisions and any failures.
- [x] Blog post.
- [x] Mark roadmap complete and commit.

## Result

Kodr now has a first-pass interactive permission contract:

- `ToolRunner` can call an injected permission approver when policy denies a
  read, write/apply, command, or network action.
- The shared channel accepts `permission-request` and `permission-decision`
  messages.
- `kodr tui` stores a pending permission request and resolves it with `/allow`
  or `/deny`.

The initial implementation does not add a persistent trust store or automatic
run resumption. It establishes the shared approval shape that later install,
git, web UI, and skill execution phases can reuse.
