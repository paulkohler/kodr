# Phase 67: Skill Code Execution

## Goal

Allow skills to provide executable helper scripts, gated by explicit permission.

This is separate from Phase 64 resource references because executable skill
content changes the trust model. The model must treat skill scripts as
untrusted project-adjacent code, and Kodr must never run them implicitly.

## Design

Add frontmatter metadata for skill commands:

- command name
- relative script path
- description
- allowed arguments schema or fixed argument list

Execution must use the controlled-exec pattern, workspace/skill-directory jails,
timeouts, artifact logging, and the TUI permission path from Phase 65.

## Non-Goals

- No arbitrary command strings from skills.
- No Python-specific runtime assumption.
- No automatic execution during skill load.

## Done Criteria

- [ ] Parse executable command metadata from `SKILL.md` frontmatter.
- [ ] Expose command names/descriptions without exposing full script bodies.
- [ ] Execute only declared, jailed commands after explicit approval.
- [ ] Record stdout/stderr as artifacts.
- [ ] Add tests for approval, denial, timeout, and path traversal.
- [ ] Record decisions and any failures.
- [ ] Blog post.
- [ ] Mark roadmap complete and commit.
