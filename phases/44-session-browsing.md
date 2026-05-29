# Phase 44: Session Browsing (optional)

## Goal

Make session chains browsable from the CLI, building on the `sessionId` /
`parentRunDir` links from phases 42–43.

## Design

- `kodr session list` — list known sessions (grouped by `sessionId`) with turn
  count, model(s), last activity, and latest run dir.
- `kodr session show <id>` — print the conversation chain for a session: each
  user/assistant turn in order, with per-turn finish reason and token usage.
- Reuse the run-history scanning logic (`run-history.mjs`) rather than adding a
  separate index.

## Done Criteria

- [ ] `kodr session list` with structured + human output.
- [ ] `kodr session show <id>` renders the ordered conversation.
- [ ] Reuses existing run-history scanning.
- [ ] Tests cover listing, show, and the empty/no-sessions case.
- [ ] Record decisions and any failures.
- [ ] Blog post.
