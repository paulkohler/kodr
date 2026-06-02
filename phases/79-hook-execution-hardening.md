# Phase 79: Hook Execution Hardening

## Goal

Tighten command hook execution semantics before hooks are treated as a primary
safety mechanism.

Phase 78 added opt-in command hooks and Stop decision control. Cycle review
identified three boundaries that should become explicit product behavior:

- Stop hooks currently run before normal proposal writes are applied.
- PostToolUse observes after tool effects and cannot prevent those effects.
- Command hooks currently run on the host cwd, even when Docker sandboxing is
  enabled for install/test/tool commands.

## Design

Add a clearer lifecycle split:

- `PreToolUse`: prevention before tool effects.
- `PostToolUse`: audit/feedback after tool effects.
- `Stop`: model-loop guard before accepting final assistant text.
- future `PostApply` or `PostRun`: final checks after writes, installs, and
  verification have happened.

Route command hook execution through the same executor abstraction used for
host/Docker/OpenShell command effects when practical. If a hook must run on the
host, artifacts should say so explicitly.

## Lifecycle Order

Hooks fire in this order within the model loop:

1. `PreToolUse` — before a native tool effect runs. A block prevents the effect
   and reports the reason back to the model.
2. `PostToolUse` — after a tool effect succeeds. Audit/feedback only.
3. `Stop` — after the assistant's final response, before Kodr ends the loop. A
   block forces another model turn.

Each hook run records its execution `environment` (`host` or `docker`) in
`hooks.json`. With `--docker-sandbox`, hook commands run inside the sandbox via
`docker run -i` so they share the install/test/tool environment; input JSON is
piped on stdin.

## Deferred: Post-Apply Final Check Hook

A `PostApply`/`PostRun` hook is deferred to a later phase. Unlike `Stop` (which
guards a still-open model loop), a post-apply hook fires after writes, installs,
and verification have completed, so a "block" cannot feed back into the loop —
it can only fail the finished run. Defining that semantics and wiring it through
the standard, staged, and healing flows is its own phase. See
`process/decisions.jsonl`.

## Non-Goals

- No HTTP hooks.
- No prompt hooks.
- No async/background hooks.
- No broad Claude Code hook compatibility.

## Done Criteria

- [x] Document hook lifecycle order in CLI usage and phase docs.
- [x] Add command-backed `PreToolUse` config support for prevention examples.
- [x] Add a post-apply/post-run final check hook or an explicit design decision
      deferring it. (Deferred — see decisions and the section above.)
- [x] Route hook commands through the configured executor where supported.
- [x] Artifact hook execution environment (`host`, `docker`, `openshell`, etc.).
- [x] Add tests proving destructive command prevention happens before effects.
- [x] Post-apply final-check hook deferred, so the "sees applied writes" test is
      deferred with it.
- [x] Record decisions and failures.
- [x] Blog post.
- [x] Mark roadmap complete and commit.
