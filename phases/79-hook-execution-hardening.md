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

## Non-Goals

- No HTTP hooks.
- No prompt hooks.
- No async/background hooks.
- No broad Claude Code hook compatibility.

## Done Criteria

- [ ] Document hook lifecycle order in CLI usage and phase docs.
- [ ] Add command-backed `PreToolUse` config support for prevention examples.
- [ ] Add a post-apply/post-run final check hook or an explicit design decision
      deferring it.
- [ ] Route hook commands through the configured executor where supported.
- [ ] Artifact hook execution environment (`host`, `docker`, `openshell`, etc.).
- [ ] Add tests proving destructive command prevention happens before effects.
- [ ] Add tests proving final check hooks see applied writes when implemented.
- [ ] Record decisions and failures.
- [ ] Blog post.
- [ ] Mark roadmap complete and commit.
