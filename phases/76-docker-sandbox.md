# Phase 76: Docker Sandbox

## Goal

Add an opt-in `--docker-sandbox` execution mode that runs Kodr's tool effects
inside a Docker container with the current workspace mounted as the only writable
project boundary.

The goal is to make command execution, dependency installs, verification, and
future tool workflows safer without pretending model output is trusted. The
container becomes the operating-system boundary; Kodr's existing path checks
remain the application boundary.

## User Surface

Initial CLI shape:

```sh
kodr run -p "task" --tools --yes --docker-sandbox
kodr run --prompt-file prompt.md --tools --yes --install --test "npm test" --docker-sandbox
kodr run -p "task" --docker-sandbox --docker-keep
kodr run -p "task" --docker-sandbox --docker-network none
```

Proposed flags:

- `--docker-sandbox`: run tool effects through a Docker container.
- `--docker-image <image>`: default to a Kodr-maintained Node image, likely
  `node:24-bookworm-slim` initially.
- `--docker-keep`: keep the container after command completion for debugging.
  Default is remove on completion.
- `--docker-network <mode>`: default `none` for verification-only tasks and
  `bridge` only when the user explicitly requests dependency install or network
  tools. Accept `none`, `bridge`, and possibly a named Docker network later.
- `--docker-workdir <path>`: internal container workspace path, default
  `/workspace`.

## Execution Model

Kodr stays on the host. The model call and run artifacts stay host-side. Tool
effects that touch the filesystem or run commands are routed through a Docker
executor:

- mount the host cwd to `/workspace`
- set container workdir to `/workspace`
- run as a non-root uid/gid matching the host user when practical
- mount the workspace read-write
- mount optional temp/cache dirs separately, not the host home directory
- do not mount `/var/run/docker.sock`
- pass only explicitly required env vars
- run commands without a shell, preserving the existing allowlist model

Writes still flow through Kodr's safe-write layer. For direct file writes, Kodr
can either:

- write from the host after validating paths, preserving today's behavior, or
- call a container-side helper that writes to `/workspace` after receiving a
  validated relative path.

The first implementation should prefer host-side safe writes plus
container-side command execution. That gives most of the security benefit for
commands, installs, and tests without making file-write semantics harder.

## Filesystem Boundary

Mount only the current cwd:

```text
host cwd -> /workspace
```

A write outside `/workspace` should fail at multiple layers:

- Kodr rejects absolute paths and `..` path segments before Docker is involved.
- container commands run with `/workspace` as the working directory.
- no host parent directories are mounted, so accidental writes outside the
  workspace cannot write back to the host.

Container-created files will write back through the bind mount. Kodr must test
ownership and permissions on macOS/Linux so generated files remain editable by
the host user.

## Network Policy

Network should be explicit because examples need package installs but many
verification runs do not.

Default proposal:

- `--docker-sandbox` alone uses `--network none`.
- `--docker-sandbox --install` uses `--network bridge` unless overridden.
- `fetch_url` keeps the existing host/private-address blocking even when the
  fetch executes in a container.
- future permission policy can require approval before enabling network.

Open questions:

- Should package installs require `--docker-network bridge`, or is `--install`
  enough consent?
- Should LM Studio access from inside the container be allowed? Initial answer:
  no. Model calls stay host-side, so the container does not need access to
  `localhost:1234`.
- Should Docker DNS/network errors become first-class artifacts? Yes.

## Container Lifecycle

Default behavior:

- create a fresh named container per run or tool session
- remove it on successful completion
- remove it on failure unless `--docker-keep` is set
- always record container id/name/image/network in artifacts

With `--docker-keep`:

- keep the container after command completion
- print the container name/id
- record a suggested `docker exec` command in artifacts
- never keep by default, because stale containers are confusing and can retain
  sensitive generated state

Named container convention:

```text
kodr-<run-id>-<short-random>
```

## Artifacts

Add `docker.json` to run artifacts:

```json
{
  "enabled": true,
  "image": "node:24-bookworm-slim",
  "containerId": "...",
  "containerName": "kodr-...",
  "network": "none",
  "workspaceMount": {
    "host": "/abs/cwd",
    "container": "/workspace"
  },
  "kept": false,
  "commands": [
    {
      "command": "npm test",
      "exitCode": 0,
      "durationMs": 1234
    }
  ]
}
```

Command/install/test artifacts should retain their existing shapes and include a
field showing whether they executed on host or Docker.

## Implementation Plan

1. Add CLI parsing and usage for `--docker-sandbox`, `--docker-image`,
   `--docker-keep`, `--docker-network`, and `--docker-workdir`.
2. Add a Docker availability probe using allowlisted `docker` commands without
   a shell.
3. Add a `DockerExecutor` abstraction with:
   - create/start container
   - exec allowlisted command
   - copy/record metadata
   - cleanup/keep lifecycle
4. Route verification and dependency install runners through the executor.
5. Keep model calls and safe writes host-side for the first implementation.
6. Record `docker.json`.
7. Add tests with a fake Docker command runner. Do not require Docker for unit
   tests.
8. Add one optional local integration test note for real Docker.

## Non-Goals

- No Docker Compose orchestration in the first pass.
- No nested Docker or host Docker socket mount.
- No running the model server in Docker.
- No arbitrary shell command support.
- No full filesystem virtualization for host-side safe writes yet.

## Docker Compose Consideration

Docker Compose is useful for example services such as Postgres, but it is a
different responsibility from sandboxing Kodr tool execution.

Initial decision:

- use plain `docker run` / `docker exec` for the sandbox container
- let generated projects keep their own `docker-compose.yml`
- later, add service orchestration as a separate phase if Kodr needs to start
  project dependencies during verification

The sandbox container and project service containers may need a shared Docker
network later. That should be explicit and artifacted.

## Risks

- macOS bind-mount performance can make tests slower.
- file ownership may be awkward across host/container boundaries.
- `npm install` inside containers can produce platform-specific lockfile or
  native module differences.
- network defaults can surprise users if installs fail under `none`.
- Docker Desktop availability and daemon state need clear error messages.

## Done Criteria

- [x] CLI parses Docker sandbox flags and documents them.
- [x] Docker executor is abstracted and fake-runner tested.
- [x] Verification can run inside the sandbox.
- [x] Dependency install can run inside the sandbox.
- [x] `docker.json` records image, network, mount, lifecycle, and command
      metadata.
- [x] Default lifecycle removes containers after completion.
- [x] `--docker-keep` preserves a failed container and reports how to inspect it.
- [x] Network mode defaults are tested.
- [x] Path escape attempts still fail and cannot write outside the mounted cwd.
- [x] Record decisions and failures.
- [x] Blog post.
- [ ] Mark roadmap complete and commit.
