# Phase 262 — lang:node Dynamic Import in describe() Pitfall

## Goal

Add a preamble bullet to `src/builtin-skills/languages/node/SKILL.md` warning
that `await import()` inside a `describe()` or other non-async function body is a
SyntaxError. Static imports belong at the module top level.

## Motivation

Phase-256 ambitious dogfood: model wrote `const http = await import('node:http')`
inside a `describe()` callback body. `await` outside an async function is a
SyntaxError — the module fails to parse entirely. The pitfall must appear early
enough (preamble) that the model sees it before generating any import statement.

## Work items

- [x] Edit preamble of `src/builtin-skills/languages/node/SKILL.md` — add the
  dynamic-import bullet after the DatabaseSync anchor line.
- [x] Rebuild bundle: `node bin/build-skills.mjs`
- [x] Add test in `test/builtin-skills.test.mjs`:
  `lang:node warns against dynamic await import inside describe()`
- [x] `npm run format`, `npm test`, `npm run check`
- [x] `process/decisions.jsonl` entry
- [x] Blog post `blog/262-lang-node-dynamic-import-describe.md`
- [x] Roadmap entry, NEXT.md candidate deleted, version bumped to `0.0.262`
- [x] Commit: `Phase 262: lang:node dynamic import in describe() pitfall`

## Done criteria

- `getBuiltinSkill('lang:node').body` matches `/await import\(/`
- It also matches `/SyntaxError|await.*outside async/i`
- The match index is before the first `\n## ` (i.e. in the preamble)
- All tests green
