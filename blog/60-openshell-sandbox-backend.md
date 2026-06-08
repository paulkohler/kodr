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

## Failures Found

The previously installed `openshell 0.0.20` did not expose the documented
`sandbox exec` command. A real local probe failed before the model call with an
actionable error and wrote `openshell.json`:

```text
OpenShell CLI is incompatible: missing "sandbox exec".
```

This confirmed that version checks are insufficient for alpha software. Kodr
checks the command surface directly and records failure metadata instead of
falling back to host execution.

After upgrading the CLI and rebuilding the local gateway on `openshell 0.0.56`,
a direct base sandbox successfully ran Node.js, npm, and a file write. The first
Kodr run then found the opposite compatibility problem: Kodr always passed the
older `--no-bootstrap` create flag, which `0.0.56` removed.

Kodr now capability-detects that optional flag from `sandbox create --help`.
Older CLIs that advertise it still receive the explicit no-bootstrap request;
current CLIs can create a sandbox without an unsupported argument. Required
commands remain strict capabilities, while optional flags are negotiated.

An isolated Kodr example run then created a base sandbox, synchronized its
workspace, ran `node --test` through OpenShell, recorded the executor metadata,
and cleaned the sandbox up. The local Nemotron model proposed zero files, so
verification correctly failed because no tests were discovered. That is an
example-generation failure, not a sandbox failure, and the example was not
hand-fixed.

A direct sandbox using Kodr's generated default-deny policy returned HTTP `403`
for an attempted `https://example.com` request, confirming that the rebuilt
gateway enforced the closed network policy.

On 2026-06-08, the real `OpenShellExecutor` path completed the remaining
integration check with `openshell 0.0.56` and a local gateway reporting server
version `0.0.57` at `https://127.0.0.1:17670`. The probe created a persistent
sandbox, uploaded a filtered workspace snapshot, mapped a nested host directory
to `/sandbox/nested`, preserved sandbox-only dependency state between commands,
denied an outbound `https://example.com` request under the generated
default-deny policy, and deleted the sandbox on finalize.

That run also found a practical compatibility constraint: OpenShell rejects
command arguments containing literal newline or carriage return characters.
Kodr's controlled command paths already favor parsed fixed arguments, but future
skill execution should pass complex payloads through stdin or files instead of
newline-heavy command arguments.

## Verification

- `npm run format`
- focused executor, CLI, channel, and hook tests
- `npm test`
- `npm run check`
- local incompatible-CLI probe against `openshell 0.0.20`
- upgraded CLI and rebuilt local gateway on `openshell 0.0.56`
- direct base sandbox Node.js, npm, and file-write smoke test
- isolated Kodr run reached OpenShell verification and cleanup
- default-deny network request returned HTTP `403`
- real executor integration run covering nested working directories, dependency
  persistence, network denial, verification-shaped command execution, and
  cleanup
