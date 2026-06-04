# Phase 60: OpenShell Sandbox Backend

Phase 60 adds an opt-in `--openshell-sandbox` command boundary for Kodr runs.
OpenShell is treated as an upload-and-execute backend, not as a Docker bind-mount
replacement.

Kodr creates one persistent sandbox for the run, uploads a filtered workspace
snapshot, and routes dependency install, verification, `run_command`, and
command hooks through `openshell sandbox exec`. The model call, proposal
validation, safe writes, and artifacts remain host-side.

## Security Shape

The backend refuses silent fallback. It capability-probes `sandbox create`,
`sandbox exec`, `sandbox upload`, and `sandbox delete`, requires a running
loopback gateway, and rejects remote gateways because they would receive
workspace files.

The upload snapshot excludes `.git`, `.kodr`, `node_modules`, `KODR_MEMORY.md`,
and environment secret files. Symlinks that resolve outside the workspace are
rejected. Without an explicit policy, Kodr writes a default-deny policy for the
run. Dependency installs require an explicit `--openshell-policy`.

OpenShell command effects are not downloaded over the host workspace. Kodr
resynchronizes host safe writes before commands, but command-created files stay
inside the sandbox. The sandbox is deleted at the end unless
`--openshell-keep` is requested.

## Failure Found

The locally installed `openshell 0.0.20` does not expose the documented
`sandbox exec` command. A real local probe failed before the model call with an
actionable error and wrote `openshell.json`:

```text
OpenShell CLI is incompatible: missing "sandbox exec".
```

This confirmed that version checks are insufficient for alpha software. Kodr
checks the command surface directly and records failure metadata instead of
falling back to host execution.

## Verification

- `npm run format`
- focused executor, CLI, channel, and hook tests
- `npm test`
- `npm run check`
- local incompatible-CLI probe against `openshell 0.0.20`
