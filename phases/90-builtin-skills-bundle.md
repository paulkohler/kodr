# Phase 90: Builtin Skills Bundle

Bundle orchestration role personas as internal JSON so they travel with the
installed app regardless of the working directory.

## Problem

`discoverSkills` scans `cwd` only. After `npm run install-local`, running Kodr
in another directory finds no SKILL.md files, so role-based personas are
unavailable outside the repo.

## Solution

- `src/builtin-skills/roles/{planner,implementer,file-author,reviewer}/SKILL.md`
  — role persona files authored in the repo.
- `bin/build-skills.mjs` — globs `src/builtin-skills/**/SKILL.md`, parses with
  the existing `parseSkillMarkdown`, stamps `builtin:true`, writes to
  `src/builtin-skills.json`. `--check` exits 1 on drift.
- `src/builtin-skills.mjs` — `import ... with { type: 'json' }` bundle; exports
  `getBuiltinSkill(name)` and `getBuiltinSkills()` using `structuredClone`.
- `package.json` — `build-skills` script; `check` now runs
  `build-skills --check`.

## Done criteria

- [x] `bin/build-skills.mjs --check` exits 0 against the committed JSON.
- [x] `getBuiltinSkill('role:planner')` resolves a non-empty trusted body.
- [x] Mutations to the returned skill object do not affect the bundle.
- [x] `test/builtin-skills.test.mjs` covers all four roles plus error case.
- [x] `npm run check` includes the drift guard.
