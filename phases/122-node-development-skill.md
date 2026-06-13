# Phase 122 — Node Development Builtin Skill

## Motivation

Phase 121 shipped the ESM/Node-24 contract as a hardcoded four-line block in
`renderLanguageGuidanceBlock` (`src/system-env.mjs`), auto-injected when the
workspace signals Node/ESM. It works, but it is prose embedded in
prompt-assembly code: not data-driven, and — unlike every other guidance
surface in kodr — not override-able by a project or user.

kodr already has the machinery to do better. Builtin skills (phases 90/93) live
as markdown under `src/builtin-skills/`, get bundled to `builtin-skills.json`,
and load via `getBuiltinSkill(name)` — that is exactly how the orchestration
roles (`role:planner`, …) inject prompt text. Phase 116 added tiered skill
discovery (override > workspace > project > user) so users can shadow builtins.

This phase moves the Node/ESM contract into a builtin `lang:node` skill:
**single source of truth in markdown**, auto-applied on the existing phase-121
`isNodeEsm` trigger, and **override-able** — a project or user skill named
`lang:node` shadows the builtin. The guidance becomes data, gains
override-ability, and sets the `lang:<language>` pattern for future languages
(Python/Go) without touching the core contract again.

Evidence: `src/system-env.mjs:105` (`renderLanguageGuidanceBlock`, hardcoded);
`src/builtin-skills.mjs` (`getBuiltinSkill`); `bin/build-skills.mjs` (bundler);
`src/skills.mjs:36` (`discoverSkillsTiered`); phase 121 blog/phase files.

## Design principles

1. **Single source of truth.** The contract text lives in one place —
   `src/builtin-skills/languages/node/SKILL.md` — and the bundle is generated
   from it. No duplicated prose in `system-env.mjs`.
2. **Byte-stable.** The builtin body, when rendered, is byte-identical to the
   phase-121 block. Non-Node workspaces and the no-override Node path produce a
   prompt byte-identical to phase 121. Regression-tested.
3. **Override, don't fork.** Auto-apply stays keyed on `isNodeEsm`. A discovered
   skill named `lang:node` (any tier) replaces the builtin body; otherwise the
   builtin is used. Resolved once per session → stable prefix.
4. **Terse and budget-guarded.** The skill body stays ≈4 lines; the existing
   prompt-budget guard is unchanged. A skill is not a license to grow the block.
5. **Generalizable.** `lang:node` is the first of a `lang:<x>` family; the
   resolution path is language-parameterised so a later `lang:python` is data,
   not new code.

## Work items

### C1 — Builtin `lang:node` skill

Add `src/builtin-skills/languages/node/SKILL.md`:

```
---
name: lang:node
description: Node.js / ESM coding contract — the mechanical rules local models most often break
---
# Node.js / ESM Contract
- ESM only: use `import`/`export`; never `require` or `module.exports`; no top-level `return` outside a function.
- Tests: `import { test } from 'node:test'` and `node:assert` — do not invent methods like `t.assert()`.
- CLI argv: `process.argv` entries are separate tokens (`--top` and `3` are two entries); parse flags with a token loop, not a single-string regex.
```

Run `npm run build-skills`; `builtin-skills.json` gains the entry. `npm run
check` (`build-skills --check`) keeps it in sync.

### C2 — `renderLanguageGuidanceBlock` reads the skill

`renderLanguageGuidanceBlock({ isNodeEsm, guidance })`:
- returns `''` when `!isNodeEsm`.
- `guidance` defaults to the builtin `lang:node` body (`getBuiltinSkill`).
- a caller may pass a resolved override body as `guidance`.
- the returned text is `guidance.trim()` — byte-identical to the phase-121 block
  for the builtin body.

`renderBehavioursBlock` stays pure/constant. The block remains the fourth
section of `renderStableSection`, gated on `isNodeEsm`.

### C3 — Override resolution

In `buildWorkspaceContext` (`src/context-packer.mjs`), when `isNodeEsm`, resolve
the effective guidance: discover skills (with the run's `skillsDirs`), and if a
skill named `lang:node` exists, use its body; else leave `guidance` undefined so
the builtin default applies. Thread the resolved string through
`attachPromptMetadata` → `renderStableSection` → `renderLanguageGuidanceBlock`.
`skillsDirs` reaches context-packer via `workspaceContextOptions(options, cwd)`.

### C4 — Forensics

`summary.json` already records nothing about the language block (it is implicit
in the prompt artifacts). Add a single `languageGuidance` marker to the prompt
metadata — `{ language: 'node', source: 'builtin' | 'override' }` — so `kodr
why`/`--show-context` can report whether the builtin or a project override was
applied, omitted entirely when no block fired.

## Testing

- C1: builtin bundle contains `lang:node`; `build-skills --check` clean.
- C2: `renderLanguageGuidanceBlock({ isNodeEsm: true })` is byte-identical to the
  phase-121 block; `{ isNodeEsm: false }` → `''`; an explicit `guidance` override
  is rendered (trimmed).
- C3: a workspace with a `lang:node` override skill yields the override body in
  the system prompt; without one, the builtin; non-Node → no block. Override is
  resolved from any tier.
- C4: `languageGuidance` metadata present with correct `source`; absent when no
  block.
- Regression: non-Node and no-override Node prompts byte-identical to phase 121;
  prompt-budget guard holds.
- Full suite, `npm run format`, `npm run check` green.

## Done criteria

- [x] C1: builtin `lang:node` skill + regenerated bundle; `--check` clean.
- [x] C2: `renderLanguageGuidanceBlock` reads the skill body, byte-stable.
- [x] C3: override resolution in `buildWorkspaceContext`, threaded `skillsDirs`.
- [x] C4: `languageGuidance` prompt-metadata marker + surfacing.
- [x] `process/decisions.jsonl` updated (hardcoded-block → builtin-skill rationale).
- [x] Blog post `blog/122-node-development-skill.md`.
- [x] NEXT.md revised; version bumped to 0.0.122; suite green; committed.
- [x] Live validation: a Node/ESM greenfield run still shows the contract in the
      system prompt (builtin path), and a workspace with a `lang:node` override
      shows the override text — confirm the refactor preserved behaviour against
      a local model.
