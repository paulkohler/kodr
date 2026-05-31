# Phase 72: Undo/Redo Run Reverts

## Goal

Let users undo and redo Kodr-applied changes from CLI/TUI sessions.

OpenCode exposes `/undo` and `/redo`; Kodr needs the same recovery primitive for
real iterative use, especially before enabling more autonomous repair loops.

## Design

Build on run artifacts and patch snapshots:

- record pre-apply and post-apply state for each applied change set
- add `kodr undo` / `kodr redo`
- add TUI `/undo` and `/redo`
- show what will change before applying the revert

Prefer patch artifacts over git for the first pass so this works in repositories
without clean git state. Phase 73 can later add git-aware boundaries.

## Non-Goals

- No branch management.
- No conflict auto-resolution.
- No revert across unrelated manual edits without warning.

## Done Criteria

- [ ] Record enough apply metadata to reverse a run change set.
- [ ] Add CLI undo/redo commands.
- [ ] Add TUI slash commands.
- [ ] Detect dirty/conflicting files before revert.
- [ ] Add tests for undo, redo, and conflict refusal.
- [ ] Record decisions and any failures.
- [ ] Blog post.
- [ ] Mark roadmap complete and commit.
