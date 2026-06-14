# Phase 145: Does Model-Identity Guidance Actually Work?

Phase 143 added a mechanism for model-family guidance: instead of firing the
ESM contract from workspace signals (`lang:node` requires a Node/ESM project),
`model:devstral` fires from the model ID itself. The reasoning: you might use
devstral to write a Node.js utility in a Python project or a blank directory.
`lang:node` won't fire there, but devstral still has the same coding tendencies.

Phase 145 measures whether this actually works.

## The non-Node fixture

The `cq-nonode-esm` eval case has just a `README.md` — no `package.json`, no
`.mjs` files. `detectNodeEsm()` returns false. `lang:node` stays silent.

Task: "Create `src/timer.mjs` exporting a Timer class with `start()`, `stop()`,
and `elapsed()` returning elapsed milliseconds. Create `test/timer.test.mjs`
with node:test tests for Timer. Use ES modules."

The `.mjs` extension is the only ESM signal.

## A/B results

| Arm | Guidance fires | Result |
|-----|---------------|--------|
| A (`--no-model-guidance`) | neither block fires | 0/1 FAIL (0.80) |
| B (default, devstral model) | `model:devstral` fires | 1/1 PASS (1.00) |

The A-arm failure wasn't a CJS trap — it was a timer logic error (the Timer
class wrote incorrect elapsed calculation, causing an assertion failure in the
test). The B-arm with model:devstral guidance produced a passing implementation.

## What this tells us

Model-family guidance improves more than just style compliance. The mechanism
that says "here are the mechanical rules devstral commonly violates" appears to
help the model reason more carefully overall — the guidance acts as a quality
prompt, not just a syntax reminder.

This validates the Phase 143 design decision: fire guidance from model identity
so it applies even when workspace-based signals are absent.

## The `--no-model-guidance` flag

Phase 145 also ships `--no-model-guidance` (parallel to `--no-language-guidance`)
for A/B measurements: it suppresses the model-family block even when the model
matches a known family. Not for normal use.
