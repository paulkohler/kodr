# Phase 68: Skill Code Execution

## Goal

Allow skills to provide executable helper scripts, gated by explicit permission.

This is separate from Phase 65 resource references because executable skill
content changes the trust model. The model must treat skill scripts as
untrusted project-adjacent code, and Kodr must never run them implicitly.

## Design

Add frontmatter metadata for skill commands:

- command name
- relative script path
- description
- allowed arguments schema or fixed argument list

Execution must use the controlled-exec pattern, workspace/skill-directory jails,
timeouts, artifact logging, and the TUI permission path from Phase 67.

Executable skills must run through an active sandbox executor. Prefer the
OpenShell backend from Phase 60 when configured, while retaining Docker as a
supported fallback. Fail clearly instead of silently executing skill code on the
host when no sandbox backend is active.

## Non-Goals

- No arbitrary command strings from skills.
- No Python-specific runtime assumption.
- No automatic execution during skill load.

## Done Criteria

- [ ] Parse executable command metadata from `SKILL.md` frontmatter.
- [ ] Expose command names/descriptions without exposing full script bodies.
- [ ] Execute only declared, jailed commands after explicit approval.
- [ ] Require an active sandbox executor; never silently execute skill code on
      the host.
- [ ] Record stdout/stderr as artifacts.
- [ ] Add tests for approval, denial, timeout, and path traversal.
- [ ] Record decisions and any failures.
- [ ] Blog post.
- [ ] Mark roadmap complete and commit.
