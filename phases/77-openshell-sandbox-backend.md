# Phase 77: OpenShell Sandbox Backend

## Goal

Add an opt-in `--openshell-sandbox` execution backend that uses NVIDIA
OpenShell as the sandbox and policy boundary when it is installed and explicitly
requested.

This is not an OpenClaw integration. NemoClaw is useful as a reference for how
NVIDIA composes OpenShell, inference routing, network policy, and hardened
containers, but Kodr should integrate with OpenShell primitives directly where
possible. Kodr remains the harness: prompt assembly, proposal validation, safe
writes, artifacts, examples, and review loops stay in Kodr.

## User Surface

Initial CLI shape:

```sh
kodr run -p "task" --tools --yes --openshell-sandbox
kodr run --prompt-file prompt.md --tools --yes --install --test "npm test" --openshell-sandbox
kodr run -p "task" --openshell-sandbox --openshell-keep
kodr run -p "task" --openshell-sandbox --openshell-network deny
```

Proposed flags:

- `--openshell-sandbox`: run command/install/test effects through OpenShell.
- `--openshell-image <image-or-blueprint>`: optional runtime image or sandbox
  source, defaulting to a Kodr-compatible Node image when practical.
- `--openshell-keep`: keep the sandbox after completion for inspection.
- `--openshell-network <policy>`: start with `deny`, `install`, and `allow`
  presets, mapped to OpenShell policy configuration.
- `--openshell-workdir <path>`: internal workspace path, default `/workspace`.

Do not silently fall back to Docker or host execution when this flag is set. If
OpenShell is unavailable or incompatible, fail clearly and record the reason.

## Execution Model

Kodr stays host-side for model calls and proposal handling. OpenShell wraps
effects that execute untrusted workspace code:

- dependency installs
- verification commands
- tool `run_command` calls
- future skill command execution

Safe writes remain host-side in the first pass, using Kodr's existing
path-validation and backup behavior. The workspace is mounted or synced into the
OpenShell sandbox as the only writable project boundary. Commands run from the
sandbox workdir and write back to the host workspace only through that boundary.

## Relationship To Docker Sandbox

`--docker-sandbox` remains the simple local baseline. `--openshell-sandbox` is a
more capable optional backend for users who have OpenShell installed and want
stronger policy primitives.

Shared executor behavior should stay behind a common interface:

- command execution
- install execution
- verification execution
- network mode metadata
- lifecycle cleanup or keep
- artifact recording

The OpenShell backend should not duplicate CLI/channel execution paths.

## Security And Policy

OpenShell should own the operating-system policy boundary where possible:

- filesystem restrictions
- network egress policy
- process isolation
- credential/inference routing if configured
- operator approval for blocked egress when OpenShell exposes that flow

Kodr still owns application-level safety:

- model output is untrusted
- paths are jailed before writes
- proposals are dry-run unless explicitly applied
- patch search text must match exactly once
- artifacts record what happened

Network should default closed. Dependency installation may opt into an install
policy preset, but the resulting policy choice must be explicit in artifacts.

## Detection And Failure Behavior

When `--openshell-sandbox` is set:

- detect the `openshell` CLI without requiring it for normal Kodr use
- verify a compatible command surface before starting the run
- fail with actionable setup guidance if unavailable
- record an `openshell.json` artifact on both success and failure

Do not require NemoClaw. NemoClaw docs and blueprints can inform the design, but
the implementation should not assume OpenClaw, Hermes, or NemoClaw onboarding.

## Artifacts

Add `openshell.json`:

```json
{
  "enabled": true,
  "available": true,
  "backend": "openshell",
  "sandboxId": "...",
  "networkPolicy": "deny",
  "workspaceMount": {
    "host": "/abs/cwd",
    "sandbox": "/workspace"
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

Existing install/test artifacts should also record `executor: "openshell"` when
they run through this backend.

## Implementation Plan

1. Add CLI parsing and usage for OpenShell flags.
2. Add an OpenShell availability probe with clear version/compatibility output.
3. Add an executor interface shared by host, Docker, and OpenShell execution.
4. Implement an OpenShell executor using injected command runners for tests.
5. Route dependency install, verification, and command tools through the
   executor when `--openshell-sandbox` is set.
6. Record `openshell.json` artifacts.
7. Add unit tests with a fake OpenShell CLI runner.
8. Add a local integration note for machines with OpenShell installed.

## Non-Goals

- No OpenClaw or Hermes runtime integration.
- No requirement to install NemoClaw.
- No automatic OpenShell installation.
- No migration away from Docker sandbox in this phase.
- No model-server-in-sandbox requirement; model calls remain host-side unless a
  later inference-routing phase makes that explicit.

## Open Questions

- Which OpenShell CLI commands are stable enough to depend on directly?
- Does OpenShell expose a simple workspace bind/sync flow for arbitrary
  workloads, or does Kodr need a tiny compatible image/blueprint?
- Can OpenShell operator network approvals be cleanly surfaced through Kodr's
  shared channel layer, including TUI?
- What is the best local LM Studio routing story if an OpenShell command itself
  needs model access later?

## Done Criteria

- [ ] CLI parses and documents `--openshell-sandbox` flags.
- [ ] OpenShell availability detection is explicit and does not affect normal
      Kodr runs.
- [ ] Host, Docker, and OpenShell execution share a small executor contract.
- [ ] Dependency install can run through the OpenShell executor.
- [ ] Verification can run through the OpenShell executor.
- [ ] `run_command` tools can run through the OpenShell executor.
- [ ] Network policy selection is artifacted and defaults closed.
- [ ] `openshell.json` records sandbox lifecycle and command metadata.
- [ ] Tests cover unavailable OpenShell, successful fake execution, failure
      artifacts, and no silent fallback.
- [ ] Record decisions and failures.
- [ ] Blog post.
- [ ] Mark roadmap complete and commit.
