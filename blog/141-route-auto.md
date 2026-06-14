# Phase 141: Self-Selecting Runs

Phase 131 shipped `kodr route`: look at your run history, find the model with
the best ok-rate, and optionally write it to `.kodr/config.json` with
`--apply`. It works. The catch is that it's a separate step — you have to run
`kodr route --apply` for the recommendation to take effect, and you have to
think to do it.

`--route-auto` removes the manual step.

## What it does

When `--route-auto` is passed (or `routeAuto: true` in `.kodr/config.json`),
kodr resolves the model at run start instead of using the global default:

1. Load `.kodr/runs` history.
2. Call `recommendModel` — same function `kodr route` uses, same 3-run minimum.
3. If there's a recommendation and the model wasn't set explicitly, use it.

Explicitly set means: `--model` on the command line, `MODEL_ID` env var, or
`model` in `.kodr/config.json`. Any of those takes precedence. `--route-auto`
is a fallback for the gap: no explicit model, but a meaningful run history.

When the run directory has no history or fewer than 3 runs per model, route-auto
silently does nothing and falls through to the built-in default. No crash, no
warning.

## Where it fires

Route-auto resolves in `main()` right after version/help exits — before any
command dispatch. That means it applies to `kodr run`, `kodr tui`,
`kodr eval`, `kodr bench`, and any future commands that pass through `main()`.

## What it records

When route-auto selects a model, `summary.routeAuto` records the chosen model
ID. `kodr why` shows it as a suffix on the Model Call step:

```
✔ [ok] Model Call
       model=qwen/qwen3.6-35b-a3b ... [route-auto: qwen/qwen3.6-35b-a3b]
```

If route-auto was a no-op (no recommendation, or model was explicit), the field
is absent.

## Config

`routeAuto` is a valid key in `.kodr/config.json`:

```json
{
  "routeAuto": true
}
```

When set in project config, every run in that project auto-selects from history.
Useful for project-level "always pick the best model" without needing a
`kodr route --apply` workflow.
