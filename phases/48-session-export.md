# Phase 48: Session Export

## Goal

Export session conversations into shareable review formats.

Session browsing is useful at the terminal, but longer sessions need a durable
human-readable artifact for review, blog posts, and debugging.

## Design

Add:

- `kodr session export <id> --format markdown`

JSON is already covered by `kodr session show <id> --json`, so Markdown should
be the first export target.

The export should include:

- session id
- turn count
- model per turn
- token usage when available
- user and assistant text
- run dirs

## Done Criteria

- [ ] Add `kodr session export <id> --format markdown`.
- [ ] Markdown output is deterministic and readable.
- [ ] Tests cover success and unknown-session errors.
- [ ] README documents session export.
- [ ] Record decisions and any failures.
- [ ] Blog post.
