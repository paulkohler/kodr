# Phase 68: Skill Code Execution

Skill code execution is a trust-boundary change, so this phase keeps the first
implementation intentionally narrow.

`SKILL.md` files can now declare executable helpers:

```md
---
name: project-tools
commands:
  - name: summarize
    path: scripts/summarize.mjs
    description: Print a project summary
    args: --json
---
Use helpers only when explicitly useful.
```

Kodr exposes command names and descriptions in the skill index, but it does not
load or run script bodies during skill discovery. A tool-enabled model must ask
for a declared helper with `run_skill_command`.

The execution path is strict:

- the command must be declared by the selected skill
- the script path is jailed to the directory containing that skill's `SKILL.md`
- an active sandbox executor is required
- an explicit permission approver is required
- network is disabled
- workspace access is read-only for Docker helpers
- OpenShell helpers run in the uploaded sandbox with no host writeback
- stdout/stderr and approval metadata are recorded as run artifacts

Non-interactive CLI paths still fail closed when there is no approver. This is
deliberate. The goal is to make helper execution possible without making
workspace code execution accidental.

The important design choice was not to reuse verification execution directly.
Verification can run package scripts and may use a writable workspace. Skill
helpers are untrusted project-adjacent code, so Docker gets a read-only mount
and `--network none`, while OpenShell remains the preferred stronger boundary
when configured.

Tests cover command metadata parsing, prompt/index exposure, approval, denial,
missing sandbox, timeout reporting, path traversal, tool registration, and the
Docker read-only/no-network invocation shape.
