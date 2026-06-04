# Phase 60: OpenShell Sandbox Backend

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
kodr run -p "task" --openshell-sandbox --openshell-policy ./openshell-policy.yaml
```

Proposed flags:

- `--openshell-sandbox`: run command/install/test effects through OpenShell.
- `--openshell-from <source>`: optional sandbox source accepted by OpenShell
  `--from`. When omitted, use OpenShell's configured default sandbox source.
- `--openshell-keep`: keep the sandbox after completion for inspection.
- `--openshell-policy <path>`: explicit OpenShell policy YAML. When omitted,
  use a Kodr-owned default-deny policy with `/sandbox` as the writable workdir.

Do not silently fall back to Docker or host execution when this flag is set. If
OpenShell is unavailable or incompatible, fail clearly and record the reason.
Reject `--docker-sandbox` and `--openshell-sandbox` together.

## Execution Model

Kodr stays host-side for model calls and proposal handling. OpenShell wraps
effects that execute untrusted workspace code:

- dependency installs
- verification commands
- tool `run_command` calls
- future skill command execution

Safe writes remain host-side in the first pass, using Kodr's existing
path-validation and backup behavior.

OpenShell is not a bind-mount backend. Create one persistent sandbox per Kodr
run, upload a filtered workspace snapshot into `/sandbox`, then execute all
install, verification, tool, and hook commands in that same sandbox. Keeping one
sandbox is required so `npm install` state is available to later `npm test`
calls.

Do not download the sandbox workspace over the host cwd in this phase. Command
effects, `node_modules`, and generated files remain inside OpenShell. Kodr
proposal writes are still applied to the host by the safe-write layer. A later
phase can add selective validated writeback through a staging directory if
there is a concrete need, such as preserving a generated lockfile.

Build the upload snapshot without `.git`, `.kodr`, `node_modules`, private
memory, package-manager credentials, or other generated/sensitive harness
state. Do not rely only on OpenShell's `.gitignore` handling. OpenShell
preserves symlinks during upload, so reject snapshot symlinks that resolve
outside the host workspace.

Synchronize files to their exact `/sandbox` paths rather than uploading
top-level directories, whose destination semantics can create an extra nesting
level. Track only uploaded snapshot paths: remove stale tracked paths on later
syncs while preserving sandbox-only state such as installed `node_modules`.
Map command working directories from the host workspace to the equivalent
location under `/sandbox`.

## Relationship To Docker Sandbox

`--docker-sandbox` remains the simple local baseline. `--openshell-sandbox` is a
more capable optional backend for users who have OpenShell installed and want
stronger policy primitives.

The Docker executor work is already implemented and should be reused even
though the completed Docker phase appears later in the reordered roadmap.

Shared executor behavior should stay behind a common interface:

- command execution
- hook execution
- backend metadata
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

Network should default closed. OpenShell policies are endpoint- and
binary-specific, so do not add a misleading broad `allow` mode. Dependency
installation requires an explicit policy file in the first implementation.
Named install presets can follow after they are tested against real npm, Python,
Rust, and Go dependency flows.

OpenShell can target remote gateways, which changes the trust boundary because
Kodr uploads workspace files. Limit the first implementation to a selected local
gateway. Remote gateway support must be an explicit later design with clear
user consent and artifacted destination metadata.

## Detection And Failure Behavior

When `--openshell-sandbox` is set:

- detect the `openshell` CLI without requiring it for normal Kodr use
- verify a compatible command surface before starting the run, including
  `sandbox create`, `sandbox exec`, `sandbox upload`, and `sandbox delete`
- require an already-running local gateway and pass `--no-bootstrap` when
  creating a sandbox; Kodr must not silently create gateway infrastructure
- fail with actionable setup guidance if unavailable
- record an `openshell.json` artifact on both success and failure

Do not require NemoClaw. NemoClaw docs and blueprints can inform the design, but
the implementation should not assume OpenClaw, Hermes, or NemoClaw onboarding.

Do not gate only on a version string. OpenShell is alpha software and command
surfaces can differ between installed builds. The locally installed
`openshell 0.0.20`, for example, has upload/download commands but does not expose
the currently documented `sandbox exec` command.

## Artifacts

Add `openshell.json`:

```json
{
  "enabled": true,
  "available": true,
  "backend": "openshell",
  "sandboxId": "...",
  "gateway": {
    "endpoint": "https://127.0.0.1:8080",
    "local": true
  },
  "policy": {
    "path": ".kodr/policies/openshell-deny.yaml",
    "network": "default-deny"
  },
  "workspaceSync": {
    "host": "/abs/cwd",
    "sandbox": "/sandbox",
    "writeback": false
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
2. Add an OpenShell capability probe and local-gateway check before model calls.
3. Add a small active-executor interface shared by Docker and OpenShell:
   `run`, `hookExecutor`, `metadata`, and `finalize`.
4. Build a filtered upload snapshot, create one persistent sandbox with
   `--no-bootstrap` and a harmless initial command such as `/bin/true`, then
   synchronize files to exact paths under `/sandbox`.
5. Implement command execution with the documented `openshell sandbox exec`
   surface, without a shell.
6. Route dependency install, verification, command tools, and hooks through the
   active executor.
7. Finalize by deleting the sandbox unless `--openshell-keep` was requested.
8. Record `openshell.json` artifacts on success and failure.
9. Add unit tests with a fake OpenShell CLI runner.
10. Add a local integration note for machines with a compatible OpenShell CLI
    and running gateway.

## Non-Goals

- No OpenClaw or Hermes runtime integration.
- No requirement to install NemoClaw.
- No automatic OpenShell installation.
- No automatic OpenShell gateway bootstrap.
- No migration away from Docker sandbox in this phase.
- No model-server-in-sandbox requirement; model calls remain host-side unless a
  later inference-routing phase makes that explicit.
- No remote OpenShell gateways.
- No arbitrary sandbox-to-host workspace writeback.
- No configurable sandbox workdir in the first pass.
- No broad network allow mode or untested language package-manager presets.

## Open Questions

- Can OpenShell operator network approvals be cleanly surfaced through Kodr's
  shared channel layer, including TUI?
- What is the best local LM Studio routing story if an OpenShell command itself
  needs model access later?
- Should selective lockfile writeback be added after download-to-staging and
  safe-write validation?
- Which tested policy presets are useful enough to ship for npm, PyPI, Cargo,
  and Go modules?

## Done Criteria

- [x] CLI parses and documents `--openshell-sandbox` flags.
- [x] OpenShell availability detection is explicit and does not affect normal
      Kodr runs.
- [x] Capability detection rejects incompatible CLI surfaces without relying
      only on a version string.
- [x] A running local gateway is required; Kodr does not auto-bootstrap one.
- [x] Docker and OpenShell execution share a small active-executor contract
      without changing normal host execution behavior.
- [x] One persistent sandbox is used for all command effects in a run.
- [x] A filtered workspace snapshot is uploaded without harness/private state.
- [x] Workspace synchronization uses exact file destinations, removes stale
      tracked paths, and preserves sandbox-only dependency state.
- [x] Nested command working directories map to the equivalent sandbox path.
- [x] Snapshot creation rejects symlinks that resolve outside the host
      workspace.
- [x] Dependency install can run through the OpenShell executor.
- [x] Verification can run through the OpenShell executor.
- [x] `run_command` tools can run through the OpenShell executor.
- [x] Command hooks can run through the OpenShell executor.
- [x] Policy selection is artifacted and defaults closed.
- [x] Dependency installation without an explicit suitable policy fails clearly.
- [x] `openshell.json` records sandbox lifecycle and command metadata.
- [x] Tests cover unavailable OpenShell, successful fake execution, failure
      artifacts, and no silent fallback.
- [x] Record decisions and failures.
- [x] Blog post.
- [ ] A compatible real OpenShell integration run exercises nested directories,
      dependency state persistence, network denial, verification, and cleanup.
- [ ] Mark roadmap complete and commit.
