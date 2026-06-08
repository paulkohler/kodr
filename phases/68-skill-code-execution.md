# Phase 68: Skill Code Execution

## Goal

Allow skills to provide executable helper scripts, gated by explicit permission.

This is separate from Phase 66 resource references because executable skill
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

The first implementation is for read-only, stdout-producing helper commands.
Skill commands receive no network access, inherited credentials, or writable
workspace capability. Approval text must show the exact command, fixed or
validated arguments, sandbox backend, and requested capabilities. File-generating
skill helpers require a later selective validated writeback design.

## Non-Goals

- No arbitrary command strings from skills.
- No Python-specific runtime assumption.
- No automatic execution during skill load.
- No file-generating skill helpers.

## Done Criteria

- [x] Parse executable command metadata from `SKILL.md` frontmatter.
- [x] Expose command names/descriptions without exposing full script bodies.
- [x] Execute only declared, jailed commands after explicit approval.
- [x] Require an active sandbox executor; never silently execute skill code on
      the host.
- [x] Run skill helpers with no network, inherited credentials, or writable
      workspace capability.
- [x] Approval text shows the exact command, arguments, backend, and
      capabilities.
- [x] Record stdout/stderr as artifacts.
- [x] Add tests for approval, denial, timeout, and path traversal.
- [x] Record decisions and any failures.
- [x] Blog post.
- [x] Mark roadmap complete and commit.

## Result

Kodr now parses `commands:` from `SKILL.md` frontmatter and exposes command
names/descriptions in skill indexes and prompts without loading script bodies.

The `run_skill_command` native tool executes only declared commands, jails the
script path to the declaring skill directory, requires an active sandbox
executor, and requires an explicit permission approver. Without an approver or
sandbox executor it fails closed.

Docker skill commands run with `--network none` and a read-only bind mount.
OpenShell skill commands run inside the uploaded sandbox with no host writeback.
Each run records stdout/stderr and approval metadata under
`skill-commands/*.json`.
