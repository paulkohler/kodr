# Phase 141 — Route Auto

## Motivation

Phase 131 shipped `kodr route --apply` to set the project default model from
run-history ok-rate. That's a manual step. The daily-driver gap: when you
start a run in a project where `kodr route --apply` hasn't been run, you still
get the global default, not the best-performing model.

`--route-auto` closes this: at run start, load the local run history, call
`recommendModel`, and use the recommendation as the model — only when the model
wasn't explicitly set by flag, env var, or project config.

## Design

`--route-auto` is resolved in `main()` after `parseArgs` and after the
early-exit commands (version/help). The check is:

```
if (options.routeAuto && !options.modelExplicit) {
  load trends; recommendModel; if rec.recommended: set options.model
}
```

`modelExplicit` is already set by `parseArgs` (via `configSources.model`
from flag/env/project-config). If the model was set by any of those paths,
`--route-auto` is a no-op. Only when the model resolves from the builtin
default does route-auto take over.

The resolved model is also stored in `options.routeAutoModel` so it can be
recorded in `summary.routeAuto` and surfaced in `kodr why`.

If trends load fails or there is no recommendation (insufficient history),
`--route-auto` silently falls through to the default.

`routeAuto` is configurable in `.kodr/config.json` as a boolean, so users who
always want auto-routing can set it once and forget it.

## Files changed

- `src/project-config.mjs`: add `routeAuto` to `KNOWN_KEYS` + boolean validation.
- `src/app.mjs`:
  - `parseArgs` defaults + `--route-auto` flag
  - `main()`: resolve route-auto after early exits, set model + `routeAutoModel`
  - `runPrompt`: record `summary.routeAuto`
  - usage string
- `test/app.test.mjs`: unit tests for route-auto resolution

## Done criteria

- [x] `--route-auto` resolves model from history when model not explicit.
- [x] No-op when model is set explicitly (--model / env / project config).
- [x] No-op when history is empty or model server unreachable (silent fallback).
- [x] `routeAuto` accepted in `.kodr/config.json`.
- [x] `summary.routeAuto` recorded; visible in `kodr why` under Model Call.
- [x] Unit tests pass; full suite green (1377/1377); format + check pass.
- [x] `process/decisions.jsonl` entry.
- [x] Blog post `blog/141-route-auto.md`.
- [x] NEXT.md: per-task model routing item updated.
- [x] Version bumped; committed.
