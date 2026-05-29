# Phase 47: TUI Streaming Status

## Goal

Make long local model calls less opaque in `kodr tui`.

The TUI should show useful status before and during a turn so users are not left
staring at a frozen prompt while LM Studio processes a large request.

## Design

- Print request start metadata before calling the model:
  - model
  - provider
  - session id or `new`
  - apply/tools mode
  - timeout and loop budgets
- Show elapsed time for long-running calls.
- When `--stream` is active, show streamed assistant text as it arrives.
- Handle interrupt/EOF cleanly without corrupting session state.

## Done Criteria

- [x] TUI prints start metadata for each model turn.
- [x] Long-running calls show elapsed status.
- [x] Streaming mode works in TUI without breaking artifacts.
- [x] Interrupt/EOF behavior is tested.
- [x] Record decisions and any failures.
- [x] Blog post.
