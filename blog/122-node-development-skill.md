# Phase 122: Guidance Is Data, Not Code

Phase 121 taught the harness three Node/ESM rules the local models kept
breaking — ESM-only, the real `node:test` API, argv-as-tokens — and injected
them as a four-line block whenever the workspace looked like Node. It worked.
But the rules lived as a string literal inside `renderLanguageGuidanceBlock`,
prompt-assembly code. That is the one guidance surface in kodr that a project
or user could not change, and the only one written as code rather than data.

kodr already had the right shape sitting next to it. Builtin skills (phases
90/93) are markdown under `src/builtin-skills/`, bundled to JSON, and injected
by name — that is exactly how the orchestration roles (`role:planner`, …) reach
the prompt. Phase 116 then added tiered discovery so a user skill can shadow a
builtin. The Node contract was the one piece of guidance that hadn't been moved
onto that road yet.

## The move

Phase 122 turns the contract into a builtin `lang:node` skill:

```
src/builtin-skills/languages/node/SKILL.md
---
name: lang:node
description: Node.js / ESM coding contract — the mechanical rules local models most often break
---
# Node.js / ESM Contract
- ESM only: ...
- Tests: ...
- CLI argv: ...
```

`renderLanguageGuidanceBlock` no longer holds the text. It reads the builtin
body and `.trim()`s it — the trailing newline a markdown file carries is the
only difference, so the rendered block is byte-for-byte the phase-121 block.
The phase-121 prefix-stability tests passed unchanged, which is the proof the
refactor preserved behaviour: same bytes, different source.

## What the move buys

**Override, not fork.** Auto-apply still keys on the phase-121 `isNodeEsm`
signal (now including the greenfield prompt cue). But before falling back to the
builtin, `buildWorkspaceContext` discovers skills for the run and, if it finds
one named `lang:node` in any tier, uses *its* body instead. A team that wants
"every CLI prints usage on missing args" drops a `lang:node` SKILL.md in
`.kodr/skills/` and it shadows the builtin — no code change. Validated live: a
gpt-oss run with a project override carried the house rule into the system
prompt; without one, the builtin. The run summary records which fired:

```json
"languageGuidance": { "language": "node", "source": "builtin" }
```

and `kodr why` shows it in Context Assembly (`node guidance: builtin` /
`… override`). The hardcoded block could report nothing; the skill can say where
it came from.

**A pattern, not a special case.** `lang:node` is the first of a `lang:<x>`
family. The resolution path is language-parameterised, so a future
`lang:python` is a markdown file and a detection cue, not new prompt code. The
same is true of the still-open per-model-family guidance: the natural shape is
now "a skill the harness auto-applies on a fingerprint," not another literal in
`system-env.mjs`.

## The discipline that came with it

Two things had to stay true, and the tests enforce both. The body stays terse —
a skill is not a license to grow the block, and the budget guard is unchanged.
And the seam avoided a static import cycle: `skills.mjs` already imports from
`context-packer.mjs`, so the override resolver reaches discovery through a
dynamic `import()` and swallows any discovery failure back to the builtin —
prompt assembly must never break because a skill file is malformed.

## Where this leaves the arc

121 moved the frontier from the harness to the code the models write, and
started coaching that code. 122 makes the coaching a first-class, override-able,
measurable surface instead of a literal. The open question 121 left — *does the
guidance actually reduce mistakes?* — is unchanged by where the text lives, and
is still a bench question. But now the answer can vary by project and by
language without touching the engine, which is the right place for it to live.
