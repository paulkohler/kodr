# Phase 67: Interactive TUI Permission Prompts

Kodr already had a permission policy layer, but denied actions were just errors.
That is safe, but it is not enough for an interactive coding harness. The user
needs to see what is being requested and make an explicit decision.

Phase 67 adds the first shared approval contract.

At the tool layer, `ToolRunner` can now receive a `permissionApprover`. When a
policy denies a file read, file write/apply, command, or network request, the
runner builds a structured permission request:

```json
{
  "action": "run_command",
  "input": { "command": "npm install" },
  "reason": "Command is denied by policy: npm install",
  "status": "pending"
}
```

If the approver returns `{ "decision": "allow" }`, the action proceeds once. If
it returns deny, the tool call fails with a permission-denied error. Without an
approver, CLI behavior stays fail-closed and compatible with the previous
policy behavior.

The shared channel now also understands `permission-request` and
`permission-decision`. The default channel response denies requests when there is
no interactive approver, which keeps non-interactive runs safe.

The TUI stores a pending permission request and exposes two line-oriented
commands:

```text
/allow
/deny
```

This is intentionally not a full trust-store or retry engine. It is the shared
message shape and presentation path. Later phases can use the same contract for
dependency installs, git operations, web UI prompts, and skill code execution.

Tests cover approved and denied tool actions, the channel request/decision
contract, and TUI `/allow` and `/deny` handling.
