# Phase 78: Command Hooks And Stop Control

Phase 78 turns hooks from an internal test seam into a user-facing harness
surface.

The important choice is that configured hooks are opt-in. Project hook scripts
are arbitrary code, so Kodr now requires `--hooks` before reading
`.kodr/hooks.json` or a path from `--hooks-config`. That keeps the default local
model flow unchanged while allowing explicit automation when a user wants it.

The first command hooks are deliberately small:

- `PostToolUse` can observe native tool calls after they succeed. It is audit
  and feedback, not prevention.
- `Stop` can block the assistant from ending the model loop.

The Stop behavior is the useful part. A lint or test script can return:

```json
{"decision":"block","reason":"npm test failed"}
```

Kodr appends that reason as a user feedback message and lets the model continue
inside the same loop. This matches the shape we wanted from Claude Code without
copying its whole hook system.

The cycle review clarified an important boundary: Stop hooks fire before normal
proposal writes are applied. A Stop hook is therefore a model-loop guard, not a
post-apply verifier. Hooks also run host-side in this phase, even when Docker
sandboxing is enabled for installs/tests/tools. Executor-backed hooks and
post-apply final checks should be their own hardening phase.

Every command hook execution is recorded in `hooks.json`, including command,
args, event, exit code, stdout, stderr, timeout, and duration. That makes hooks
auditable enough to debug without hiding policy behavior inside the model
transcript.
