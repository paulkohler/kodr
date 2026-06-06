# Phase 88: OpenShell Worker Mode

## Goal

Add `--openshell-worker` so Kodr itself can run inside an OpenShell sandbox,
rather than only routing selected command effects through OpenShell.

The host process becomes a launcher/controller:

1. create an OpenShell sandbox
2. upload the workspace snapshot to `/sandbox`
3. upload the Kodr runtime to `/kodr`
4. execute `node /kodr/bin/kodr.mjs run ...` inside `/sandbox`
5. download only the nested `.kodr/worker-run` artifacts
6. leave host writes untouched unless a later reviewed apply step is added

This mode is intended to sit before any skill code execution work. It gives
future risky execution paths a stronger default containment model.

## User Surface

```sh
kodr run \
  --prompt-file prompt.md \
  --openshell-worker \
  --yes \
  --install \
  --test "npm test"
```

Related flags from Phase 60 still apply:

- `--openshell-from`
- `--openshell-policy`
- `--openshell-keep`

`--openshell-worker` is mutually exclusive with `--openshell-sandbox` and
`--docker-sandbox`.

## Security Model

This phase deliberately does not download arbitrary sandbox workspace changes
over the host checkout. The only downloaded path is the nested Kodr run artifact
directory.

The generated patch/writeback review flow is a follow-up. For now, a successful
worker run proves the sandbox can contain the harness and return inspectable
artifacts. Host-side application of diffs remains out of scope.

Model access is not solved with secret injection in this phase. The nested Kodr
process receives normal model/base-url flags, but no automatic API-key relay is
added. A later phase should add a host-owned model relay so remote provider keys
can stay outside the sandbox while the sandbox talks to one narrow local
endpoint.

## Done Criteria

- [x] Add `--openshell-worker` CLI parsing and help text.
- [x] Reject conflicting Docker/effects-only OpenShell modes.
- [x] Allow the requested `--openshell-worker --install --test "npm test"`
      command shape.
- [x] Create and initialize an OpenShell sandbox using the existing Phase 60
      capability checks.
- [x] Upload a minimal Kodr runtime into `/kodr`.
- [x] Run a nested `kodr run` command inside `/sandbox`.
- [x] Download only `.kodr/worker-run` artifacts into the host run directory.
- [x] Record `openshell-worker.json` and normal `openshell.json` artifacts.
- [x] Tests cover parser behavior and fake worker execution.
- [x] Blog post.
- [x] Record decisions and failures where relevant.
- [x] Commit.

## Follow-Ups

- Add a host-owned OpenAI-compatible model relay for LM Studio, Ollama,
  OpenRouter, and other providers without putting provider keys in the sandbox.
- Add reviewed diff/writeback from worker artifacts to host safe-writes.
- Add real OpenShell integration coverage with model access, dependency
  install, test execution, artifact download, and sandbox cleanup.
