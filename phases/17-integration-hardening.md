# Phase 17: Integration Hardening

## Goal

Close the security and integration gaps found during the post-roadmap review.

## Review Findings

- [x] Jail model-facing file reads and prompt-file reads.
- [x] Keep one-shot healing dry-run by default.
- [x] Cap loaded `SKILL.md` content and delimit it as untrusted Markdown.
- [x] Make `fetch_url` block resolved private/local addresses and cap response bodies.
- [x] Improve replay artifact validation and user-facing errors.
- [x] Document verification runner trust boundaries.
- [x] Wire or honestly expose completed module phases from the CLI.
- [x] Clarify safe-write backup semantics where rollback is not implemented.

## Done Criteria

- [x] Tests cover read escapes, prompt-file escapes, and symlink escapes.
- [x] Tests cover healing dry-run and explicit apply.
- [x] Tests cover skill byte caps and prompt delimiters.
- [x] Tests cover private resolved fetch targets and body caps.
- [x] Tests cover replay missing/corrupt artifact errors.
- [x] Blog post documents the security review and mitigations.
