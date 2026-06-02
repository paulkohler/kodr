# Phase 78: Command Hooks And Stop Control

## Goal

Add opt-in command-backed hooks for `PostToolUse` and `Stop`, including stop
decision control.

The immediate use cases are:

- log or audit tool results after a tool succeeds
- report suspicious command-shaped tool use after it happened
- run model-loop checks before the assistant is allowed to stop
- block the model from stopping when the final check fails, feeding the reason
  back into the next model turn

## Design

Configured hooks are enabled only with `--hooks`. Kodr reads `.kodr/hooks.json`
by default, or a workspace-relative path from `--hooks-config`.

The first supported handler type is `command`. The command receives JSON on
stdin and may return JSON on stdout:

```json
{
  "decision": "block",
  "reason": "Must be provided when Kodr is blocked from stopping"
}
```

Kodr also accepts Claude-style `hookSpecificOutput` blocks for the supported
events. Empty stdout means no decision.

Command hooks run without a shell and with a timeout. They are still arbitrary
project code, so they are opt-in and artifacted.

## Hook Events

`PostToolUse` runs after native tool dispatch succeeds. It is an audit and
feedback hook, not a prevention hook. Blocking from `PostToolUse` reports the
issue back to the model after the tool has already run. Destructive command
prevention belongs in `PreToolUse` or permission policy.

It can observe:

- `tool`
- `input`
- `result`
- `cwd`

`Stop` runs after the assistant produces a final response and before Kodr ends
the model loop. If a Stop hook blocks, Kodr appends a user feedback message with
the hook reason and continues the model loop until the hook allows stopping or
the normal turn budget is exhausted.

This Stop hook fires before normal JSON proposal writes are applied. It is a
model-loop guard, not a post-apply verifier. Final lint/test checks after
applied writes need a follow-up hook phase.

Command hooks currently run on the host cwd, even when `--docker-sandbox` is
enabled for install/test/tool commands.

## Non-Goals

- No HTTP hooks.
- No prompt hooks.
- No async/background hooks.
- No full Claude Code hook schema compatibility.
- No implicit execution of project hook config without `--hooks`.
- No executor-backed hook execution yet.

## Done Criteria

- [x] Add `--hooks` and `--hooks-config`.
- [x] Load command hooks from a workspace-jailed JSON config.
- [x] Support command-backed `PostToolUse`.
- [x] Support command-backed `Stop`.
- [x] Support stop block decisions that feed the reason into the next model
      turn.
- [x] Record hook executions in `hooks.json`.
- [x] Add tests for config loading, post-tool hooks, command matching, and stop
      decision control.
- [x] Record decisions and failures.
- [x] Blog post.
- [x] Mark roadmap complete and commit.
