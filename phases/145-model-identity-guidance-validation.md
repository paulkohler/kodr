# Phase 145 — Model-Identity Guidance Validation

## Motivation

Phase 143 added model-family guidance that fires from model identity rather
than workspace detection. The premise: `lang:node` only fires in Node/ESM
workspaces; `model:devstral` should fire regardless of workspace so devstral
gets guidance even when writing Node.js code in a non-Node project.

Phase 143 validated the mechanism exists. Phase 145 validates it WORKS in
the scenario it was designed for: a non-Node workspace where lang:node is
silent.

## Design

1. **`--no-model-guidance` flag** — parallel to `--no-language-guidance`;
   sets `suppressModelGuidance: true` in `workspaceContextOptions`. Lets the
   A/B measure the model-guidance block's independent effect.

2. **`cq-nonode-esm` eval case** — fixture is just a `README.md` (no
   `package.json`, no `.mjs` files). `detectNodeEsm()` returns false →
   `lang:node` does NOT fire. `detectModelFamily('mistralai/devstral-small-2-2512')`
   returns `'devstral'` → `model:devstral` fires.

3. **A/B measurement** against devstral:
   - A-arm (`--no-model-guidance`): 0/1 pass, score 0.80 — tests fail with
     assertion error (Timer logic incorrect without guidance)
   - B-arm (default): 1/1 pass, score 1.00

## Finding

`model:devstral` guidance improves both **correctness** and **style** in a
non-Node workspace. The A-arm failure was a test assertion error (Timer
class wrote incorrect elapsed logic), not just a CJS/t.assert() style trap.
The guidance appears to help the model reason more carefully, not just follow
ESM syntax rules.

## Files changed

- `src/app.mjs`: `--no-model-guidance` flag, `suppressModelGuidance` default.
- `src/context-packer.mjs`: honor `suppressModelGuidance` in family detection.
- `evals/code-quality.json`: added `cq-nonode-esm` case.
- `evals/fixtures/cq-nonode-esm/README.md` (new fixture).
- `evals/results/code-quality/mistralai-devstral-small-2-2512.jsonl`: A/B results.
- `test/app.test.mjs`: `--no-model-guidance` parse test.
- `test/context-packer.test.mjs`: `suppressModelGuidance` test.
- `test/eval.test.mjs`: updated case IDs expectation.

## Done criteria

- [x] `--no-model-guidance` flag parses and propagates through workspaceContextOptions.
- [x] `suppressModelGuidance: true` skips model-family detection in context-packer.
- [x] `cq-nonode-esm` fixture: non-Node workspace, Timer task.
- [x] A/B measurement: A-arm 0/1 FAIL (0.80), B-arm 1/1 PASS (1.00).
- [x] Results recorded in devstral results file.
- [x] Tests: 1396/1396 suite green; 2 new tests.
- [x] `process/decisions.jsonl` entry.
- [x] Blog post `blog/145-model-identity-guidance-validation.md`.
- [x] NEXT.md updated.
- [x] Version 0.0.145; committed.
