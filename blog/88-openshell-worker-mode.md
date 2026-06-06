# Phase 88: OpenShell Worker Mode

The first OpenShell integration put command effects inside a sandbox while the
Kodr harness stayed on the host. That was useful, but it was not the security
shape we actually wanted for riskier features such as code-executing skills.

Phase 88 adds `--openshell-worker`. In this mode the host Kodr process becomes a
launcher. It creates the OpenShell sandbox, uploads the workspace to `/sandbox`,
uploads the Kodr runtime to `/kodr`, and executes a nested
`node /kodr/bin/kodr.mjs run ...` inside the sandbox. The host downloads only the
nested `.kodr/worker-run` artifacts.

That boundary matters. A bad tool call, accidental write, or prompt-injection
driven command now happens against the sandbox copy of the workspace. The host
checkout is not overwritten by arbitrary sandbox state. Reviewed writeback is a
separate future step.

The first implementation intentionally does not solve provider secrets. The
nested worker receives the same model and base URL flags, but Kodr does not
inject API keys or build a relay yet. The next hardening step should be a
host-owned OpenAI-compatible relay: the sandbox can talk to one narrow local
endpoint, while OpenRouter keys and local provider routing stay on the host.

The command shape is the one we want to build around:

```sh
kodr run \
  --prompt-file prompt.md \
  --openshell-worker \
  --yes \
  --install \
  --test "npm test"
```

`--openshell-worker` is deliberately separate from `--openshell-sandbox`.
Effects-only sandboxing remains useful for quick verification. Worker mode is
the stronger harness-containment path and should be the baseline before adding
skill code execution.
