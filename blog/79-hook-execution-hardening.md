# Phase 79: Hook Execution Hardening

Phase 78 shipped opt-in command hooks but left three boundaries fuzzy. The cycle
review flagged them, and this phase turns them into explicit product behaviour.

## A named lifecycle

Hooks now have a documented order:

1. `PreToolUse` — runs before a native tool effect. A block prevents the effect.
2. `PostToolUse` — runs after the effect succeeds. Audit and feedback only.
3. `Stop` — runs after the assistant's final response, before Kodr ends the loop.

The `PreToolUse` plumbing already existed in tool dispatch from Phase 78, but it
was undocumented and untested. The hardening here is a test that proves the
guarantee: a `PreToolUse` block raises before the tool handler runs, so the
side effect never happens, while a non-matching command still runs normally.
That distinction — prevention versus audit — is the whole reason the two events
are separate.

## Hooks follow the sandbox

The bigger correctness fix is execution environment. In Phase 78, hook commands
always ran on the host cwd, even when `--docker-sandbox` was confining
install/test/tool commands. That meant a hook could see a different filesystem
and toolchain than the commands it was meant to guard.

Hook execution now goes through an executor contract. The host executor spawns
the command directly; the Docker executor runs it via `docker run -i`, mounting
the workspace and piping the hook's JSON payload on stdin. `app.mjs` picks the
executor to match the run, so `--docker-sandbox --hooks` runs hooks in the same
container as everything else. Every record in `hooks.json` now carries an
`environment` field (`host` or `docker`), so an audit shows where a hook
actually ran instead of leaving you to guess.

The routing is tested without requiring Docker: `loadConfiguredHooks` accepts an
injected executor, and the `DockerExecutor.hookExecutor()` test asserts the
`docker run -i` argument shape and stdin delivery through a fake runner.

## What we deferred, and why

The phase plan allowed either implementing a post-apply final-check hook or
explicitly deferring it. We deferred it.

`Stop` works because it guards a loop that is still open — a block can append a
user message and ask for another turn. A post-apply hook is different: it fires
after writes, installs, and verification have all finished. There is no loop
left to feed a reason back into, so "block" would have to mean "fail the
completed run," which is a different contract. Pinning that semantics down and
threading it through the standard, staged, and healing flows deserves its own
phase rather than being bolted on here. The decision is recorded in
`process/decisions.jsonl` so the deferral is intentional, not forgotten.
