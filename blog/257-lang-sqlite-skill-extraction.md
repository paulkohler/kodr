# Phase 257: Extracting lang:sqlite — When a Skill Gets Too Big to Carry

Phase 256 added the node:test hook-async pitfall to `lang:node` and the
auto-mode prompt hit **22,257 characters**. The limit had just been raised to
22,500. It was a one-phase warning: the skill file was a few hundred chars away
from needing another ceiling raise for no new knowledge.

The pressure had been building since Phase 204. Every SQLite or FTS5 pitfall
that landed in `lang:node` made the file heavier for Node tasks that never
touch a database. The gating system (Phase 248) helped — plain tasks don't pay
for the SQLite section — but the ceiling had been raised eleven times in twelve
phases. The file had grown from ~2,400 chars to 22K.

## The extraction

The `## node:sqlite pitfalls (Node.js 24)` section ran from line 49 to line 271
of `lang:node` SKILL.md — 222 lines, eleven pitfall blocks. None of it was
actually Node-specific beyond the module name: FTS5 trigger semantics, MATCH
syntax, pseudo-row delete, BigInt bind — these are SQLite pitfalls that apply
equally to a Rust or Python project using SQLite.

The extraction was a straight move:

1. Create `src/builtin-skills/languages/sqlite/SKILL.md` with frontmatter
   `name: lang:sqlite` and a `# node:sqlite / SQLite Contract` heading.
2. Move all eleven pitfall blocks verbatim — no reformatting, no gating
   headers inside the new file (the whole file is on-topic, so no gating is
   needed).
3. Replace the `lang:node` section with a 2-line cross-ref stub:

```md
## node:sqlite / SQLite

SQLite, FTS5, and `node:sqlite` (`DatabaseSync`) pitfalls live in the
`lang:sqlite` skill — inject it alongside `lang:node` for database tasks.
```

The stub keeps the `## node:sqlite / SQLite` header alive so `gateLanguageGuidance`
(which keys on `header.includes('sqlite')`) still works — it just gates a
2-line cross-ref instead of a 20K block.

`bin/build-skills.mjs` discovers SKILL.md files recursively, so the new skill
appeared automatically — no builder edits required. The bundle went from 7 to
8 built-in skills.

## The size drop

After the extraction:

- **Auto mode** (Node/ESM greenfield): 13,117 chars — down from 22,257. Limit
  lowered from 22,500 to 13,500.
- **Native mode** (Node/ESM greenfield): 12,036 chars — down from 21,164. Limit
  lowered from 21,500 to 12,500.
- **Gated/ungated ratio**: 0.546 — the plain-task gating still passes the
  `< 0.6` assertion comfortably.

The non-Node guard (`< 4000`) was unaffected.

## Test migration

Eight `it` blocks in `test/builtin-skills.test.mjs` had been asserting SQLite
content against `getBuiltinSkill('lang:node')`. Moving them to
`getBuiltinSkill('lang:sqlite')` was mechanical — rename the title prefix and
swap the skill name. The `createApp(db)` factory test (block 5) stayed on
`lang:node` because that content lives in the `## HTTP integration test patterns`
section, not the SQLite section. The ESM-cache, status-check, side-effects, and
hook-async tests also stayed.

Two tests in `test/system-env.test.mjs` needed updating:

1. `includes the phase-204/207 example pitfalls` asserted `lastInsertRowid` and
   `CURRENT_TIMESTAMP` in the `renderLanguageGuidanceBlock` output. Both are
   now in `lang:sqlite`, not `lang:node`. Removed those two assertions, kept
   `closeAllConnections` and `server.address().port` (still in the HTTP section).

2. `applies gating — includes sqlite section when task mentions node:sqlite`
   asserted `/node:sqlite pitfalls/u` was present after gating in. The stub
   says `node:sqlite / SQLite` now, so the assertion was updated to
   `/node:sqlite \/ SQLite/u`.

## What stayed and what deferred

The `createDatabase()` factory warning in `lang:node`'s module-scope side-effects
section refers to `createDatabase()` as a general anti-pattern — that text stays
in `lang:node` because it's an instance of the broader "no side effects at
module scope" rule, not SQLite-specific. The `createApp(db)` test (block 5)
verifies HTTP-section content that was never in the SQLite block.

Auto-injection wiring is deferred to Phase 258. Today, `--skill lang:sqlite`
composes it explicitly via the existing `loadSkills` path. Phase 258 will widen
`context-packer.mjs`'s scalar `detectedLanguage` to a list, so a SQLite-flavored
Node task pulls both `lang:node` and `lang:sqlite` automatically.

## The harness lesson

The prompt-size ceiling isn't just a cap — it's a forcing function. Eleven
ceiling raises in twelve phases is a signal that a topic boundary was crossed.
The extraction was obvious in retrospect: the SQLite pitfalls were always a
separate topic that happened to land in the Node skill because that was the only
available host. A file that has a cross-language concern (FTS5 trigger semantics
are the same in every language) embedded in a language-specific skill is a
cohesion problem, not a size problem.

The size problem was just the symptom that finally made the cohesion problem
visible.
