# Phase 143: Model-Family Guidance

The question coming out of phase 140 was: qwen3.6 doesn't need the lang:node
guidance block to write clean ESM and node:test code. But does devstral?

## The A/B measurement

Two runs of the code-quality eval suite against `mistralai/devstral-small-2-2512`:

**A-arm: no lang:node guidance** — 2/4 pass. The two brownfield and multi-file
cases failed. The most concrete failure: `Private field '#data' must be declared
in an enclosing class`. devstral wrote a class referencing `this.#data.size` in
a method, but never declared `#data` in the class body.

**B-arm: with lang:node guidance** — 4/4 pass. Perfect score across all four
cases, including the harder brownfield and multi-file traps.

This is a clean delta. The guidance matters for devstral. For qwen3.6 (measured
in phase 140), the same delta was null — qwen is clean without it.

## What lang:node already did

The `lang:node` builtin skill (phase 122) fires based on workspace detection:
if the project has `"type": "module"` in `package.json` or uses `.mjs` files,
the ESM + node:test contract block appears in the system prompt. The eval
fixtures are Node/ESM projects, so lang:node fires naturally in the B-arm.

So for Node workspaces and devstral: already solved.

## What's new: model-family guidance

The gap is **non-Node workspaces**. If someone is using devstral to write a
Node script in a Python project or a fresh directory, `lang:node` won't fire —
the workspace has no Node signals. The model still tends toward the same mistakes.

Phase 143 adds a parallel mechanism that fires from **model identity** instead
of workspace signals:

```
detectModelFamily('mistralai/devstral-small-2-2512') → 'devstral'
```

When a known family is detected, `resolveModelGuidance` loads the `model:devstral`
builtin skill (or a project override if one exists in a `.kodr/skills/` tier).
The skill body is appended to the stable prompt section after language guidance.

The `model:devstral` skill covers:
- Class private fields — must be declared before use
- ESM — no require
- Tests — node:test and node:assert only

## The override hierarchy

Both `lang:node` and `model:devstral` are project-overrideable: place a
`SKILL.md` with `name: lang:node` or `name: model:devstral` anywhere in the
dot-folder skill search path and it shadows the builtin. The same mechanism
used in phases 116 and 122.

In a Node/ESM workspace with devstral: both blocks fire. There's some overlap
(ESM, node:test), but the duplication is intentional — the lang:node block
fires from workspace context and would appear even if someone later switches
to qwen; the model:devstral block fires from model identity and would appear
even in a non-Node workspace.

## Observability

`summary.modelGuidance` is recorded in run summaries when the block fires:

```json
"modelGuidance": { "family": "devstral", "source": "builtin" }
```

`kodr why` shows it as a Context Assembly step:

```
[Context Assembly] model:devstral guidance: builtin
```
