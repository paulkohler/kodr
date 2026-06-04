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
environment secret files, and common credential locations such as `.npmrc`,
`.pypirc`, `.netrc`, and `.cargo`. Symlinks that resolve outside the workspace
are rejected. Without an explicit policy, Kodr writes a default-deny policy for
the run. Dependency installs require an explicit `--openshell-policy`.

OpenShell command effects are not downloaded over the host workspace. Kodr
resynchronizes host safe writes before commands, but command-created files stay
inside the sandbox. Synchronization uploads files to exact `/sandbox` paths and
removes only stale paths that Kodr previously uploaded, preserving
sandbox-created dependency state. Nested host working directories map to their
equivalent `/sandbox` path. The sandbox is deleted at the end unless
`--openshell-keep` is requested.

## Cycle Review Corrections

The first implementation passed fake-runner tests but relied on assumptions
that were too loose for a security boundary. A cycle review identified that
directory upload destination semantics could add an unwanted nesting level,
`--test-cwd` was not mapped into the sandbox, repeated uploads left stale files,
and common package-manager credentials could be included.

The executor now synchronizes individual files, tracks and removes stale
uploaded paths, maps command working directories, expands credential
exclusions, and cleans up a created sandbox when verification initialization
fails. These are now explicit tests rather than undocumented assumptions.

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

The phase remains open because the installed CLI cannot perform a compatible
end-to-end `sandbox exec` run. A real integration run is required before the
security boundary is considered complete.

## Verification

- `npm run format`
- focused executor, CLI, channel, and hook tests
- `npm test`
- `npm run check`
- local incompatible-CLI probe against `openshell 0.0.20`
- pending: compatible end-to-end OpenShell run covering nested working
  directories, dependency persistence, network denial, verification, and
  cleanup
