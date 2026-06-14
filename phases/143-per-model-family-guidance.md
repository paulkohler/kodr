# Phase 143 — Per-Model-Family Targeted Guidance

## Motivation

Phases 121/122 shipped `lang:node` (workspace-detected ESM guidance) and the
`node --check` syntax gate. Phase 140 measured the effect against qwen3.6 —
all four A/B cases null (qwen is inherently clean). The open question was:
what about devstral and gpt-oss, which have a known failure record in
`process/failures.jsonl`?

## Measurement (Phase 143 A/B)

Against `mistralai/devstral-small-2-2512`:

| Arm | Pass | Details |
|-----|------|---------|
| A (no lang:node guidance) | 2/4 | `cq-brownfield-add-tests` FAIL (0.75), `cq-multi-file-esm` FAIL (0.67) |
| B (lang:node guidance)    | 4/4 | all 1.00 |

The `cq-multi-file-esm` A-arm failure was a JS class syntax error:
`Private field '#data' must be declared in an enclosing class` — devstral
referenced `this.#data` without a class-body declaration for it.

**Finding**: lang:node IS the right intervention for devstral. The guidance
fires naturally for the eval fixtures (Node/ESM workspace). With it: perfect
score. Without it: the brownfield and multi-file trap cases fail.

## Implementation

The measurement confirmed that guidance is effective, but it only fires from
**workspace detection** (`isNodeEsm`). If a devstral user is working in a
non-Node workspace (Python project, blank dir), lang:node won't fire — even
though devstral still has the same coding tendencies.

Phase 143 adds a parallel **model-family guidance** mechanism:

- `detectModelFamily(model)` in `context-packer.mjs` — returns `'devstral'`,
  `'gpt-oss'`, or `null`.
- `resolveModelGuidance(family, cwd, options)` — discovers a project/user
  `model:<family>` override skill (same tier hierarchy as lang:node), else
  falls back to the builtin.
- `src/builtin-skills/models/devstral/SKILL.md` — `model:devstral` skill
  covering class private-field declarations, ESM, and node:test.
- `renderStableSection` updated to append model guidance body after language
  guidance (both can fire independently).
- `summary.modelGuidance` recorded in run summaries.
- `kodr why` shows a "Context Assembly: model:devstral guidance: builtin" step.

## Files changed

- `src/builtin-skills/models/devstral/SKILL.md` (new)
- `src/builtin-skills.json` (rebuilt)
- `src/context-packer.mjs`: `detectModelFamily`, `resolveModelGuidance`,
  `renderStableSection` + 3 call sites updated.
- `src/app.mjs`: `workspaceContextOptions` passes `model`; `summary.modelGuidance`.
- `src/forensics.mjs`: new Context Assembly step for model guidance.
- `test/context-packer.test.mjs`: 5 new tests.
- `evals/results/code-quality/mistralai-devstral-small-2-2512.jsonl` (new)

## Done criteria

- [x] A/B measurement: devstral 2/4 → 4/4 with lang:node guidance.
- [x] `model:devstral` builtin skill created.
- [x] `detectModelFamily` maps devstral/gpt-oss to family names.
- [x] `resolveModelGuidance` applies builtin or project override.
- [x] Model guidance fires in non-Node workspaces when model matches.
- [x] `summary.modelGuidance` recorded; `kodr why` shows the step.
- [x] 5 new context-packer tests; full suite 1393/1393 green.
- [x] `process/decisions.jsonl` entry.
- [x] Blog post `blog/143-per-model-family-guidance.md`.
- [x] NEXT.md per-model-family item removed.
- [x] Version 0.0.143; committed.
