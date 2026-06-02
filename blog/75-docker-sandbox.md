# Phase 75: Docker Sandbox

Phase 75 adds an opt-in Docker command boundary for Kodr runs.

The important decision was to keep model calls and safe writes on the host for
the first pass, while routing dependency installs, verification, and native
command tools through Docker. That keeps the write semantics simple: Kodr still
validates proposed file paths before touching the workspace, and Docker handles
the higher-risk part where trusted workspace code executes.

The new CLI surface is:

```sh
kodr run -p "task" --yes --docker-sandbox --test "npm test"
kodr run --prompt-file prompt.md --tools --yes --docker-sandbox --install --test "npm test"
kodr run -p "debug" --yes --docker-sandbox --docker-keep --test "npm test"
```

`--docker-sandbox` uses `node:24-bookworm-slim`, mounts the current workspace at
`/workspace`, and runs commands without a shell. Verification-only runs default
to `--network none`; install runs default to `bridge` because npm needs registry
access unless the user overrides it.

Each run now records `docker.json`. That artifact captures whether Docker was
enabled, the image, network mode, workspace mount, command metadata, kept
container names, and inspect commands. Tests and install artifacts also record
whether they executed on the host or in Docker.

The first implementation deliberately avoids Docker Compose and service
orchestration. Generated projects can still contain their own compose files, but
Kodr's sandbox is a separate execution boundary. If future examples need a
database service plus a sandboxed test runner, that should become an explicit
phase for project service orchestration rather than being folded into command
sandboxing.

The useful failure mode here is local inspection. With `--docker-keep`, Kodr
does not remove containers, so a developer can inspect the exact command
environment after a failed run. That makes slow local-model examples easier to
debug without loosening the default lifecycle for normal runs.
