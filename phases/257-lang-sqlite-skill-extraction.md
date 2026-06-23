# Phase 257: Extract `lang:sqlite` skill from `lang:node`

## Motivation

`src/builtin-skills/languages/node/SKILL.md` has grown to ~22K chars, and the
single largest contributor is the `## node:sqlite pitfalls (Node.js 24)` section
(SKILL.md lines 49–271 — node:sqlite import name, synchronous API, BigInt bind,
DEFAULT expression, `:memory:` test DB, FTS5 MATCH syntax, FTS5 trigger vs manual
sync, external-content FTS5 triggers, createDatabase factory, SQLite test state
reset, StatementSync row access). All of it is SQLite/FTS5 knowledge that is
**not Node-specific** beyond the `node:sqlite` module name — the FTS5 trigger
and MATCH-syntax pitfalls apply equally to a Rust + SQLite or Python + SQLite
task.

Today this content can only reach a prompt through `lang:node`, because the
auto-injection path (`src/context-packer.mjs:72`) resolves a single scalar
`detectedLanguage` (`node` | `rust` | `null`) and the gating in
`gateLanguageGuidance` (`src/system-env.mjs:116`) splits one skill body on `##`
headers. A Rust+SQLite task therefore gets zero SQLite guidance.

Extracting the SQLite content into a standalone `lang:sqlite` skill lets it be:

- **Injected independently** of `lang:node` (e.g. for Rust+SQLite tasks) — the
  wiring to actually auto-inject a secondary skill is **Phase 258**; this phase
  only creates the separable artifact and the explicit `--skill lang:sqlite`
  path (which already composes N skills via `loadSkills`,
  `src/skills.mjs:291`).
- **Smaller and more focused per file** — `lang:node` drops back to ESM/test/HTTP
  contract content; `lang:sqlite` owns the database surface.

Phase 257 is **only the extraction**: move content out of `lang:node` into a new
`lang:sqlite` SKILL.md, rebuild the bundle, and move the SQLite tests. The
auto-injection widen is out of scope and lives in Phase 258.

## Design

No runtime code changes. This is a content move plus a bundle rebuild plus a
test move. The new skill is discovered automatically by `bin/build-skills.mjs`
(it recursively globs `SKILL.md` under `src/builtin-skills/`), so no edit to the
builder is required.

### 1. Create `src/builtin-skills/languages/sqlite/SKILL.md`

New file. Frontmatter (SQLite-specific framing, not Node framing):

```md
---
name: lang:sqlite
description: node:sqlite / SQLite + FTS5 coding contract — the database pitfalls local models most often break
---
# node:sqlite / SQLite Contract
```

Then move, verbatim, every SQLite pitfall currently in `lang:node` lines 49–271.
Drop the `## node:sqlite pitfalls (Node.js 24)` wrapper header — the whole file
is now SQLite, so promote the individual pitfalls to be the body under the
`# node:sqlite / SQLite Contract` heading. Concretely, port these blocks in
order (current `lang:node` line ranges in parentheses):

- **Import name** — the only `node:sqlite` export is `DatabaseSync`; three wrong
  import forms (`Database`, `open`, default) and the correct form (51–71).
- **node:sqlite is synchronous** — no async API; `await` does nothing (73–86).
- **BigInt bind** — `lastInsertRowid` is BigInt; `Number()` before bind (88–92).
- **DEFAULT expression** — `DEFAULT (datetime('now'))` rejected; use
  `CURRENT_TIMESTAMP` (94–98).
- **SQLite in tests** — use `:memory:` (100–105).
- **FTS5 MATCH syntax** — MATCH needs the virtual table name, not a column alias
  (107–115).
- **FROM-base / WHERE-fts failure form** — "no such column: articles_fts"
  (117–130).
- **FTS5 trigger vs manual sync — pick one** — double-delete corrupts the index
  (132–164).
- **External-content FTS5 triggers** — pseudo-row delete syntax (166–195).
- **createDatabase factory** — no fixed file path at module scope (197–211).
- **SQLite test state reset** — `beforeEach` reset; module-scope refs (213–253).
- **StatementSync row access** — rows are named-column objects, not arrays
  (255–271).

Because the whole skill is SQLite, **no gating is needed** for `lang:sqlite`:
`gateLanguageGuidance` only trims sub-sections of a body; a skill that is
entirely on-topic is injected whole. Do **not** prefix the moved pitfalls with
`## ` headers that match the sqlite/http/busboy gate keywords — keep them as
bold-lead paragraphs (as they are today) so that if a future caller ever runs
`gateLanguageGuidance` over this body, the preamble-always-included rule keeps
everything. (Phase 258 will inject `lang:sqlite` un-gated.)

### 2. Trim `lang:node` SKILL.md

Remove the entire `## node:sqlite pitfalls (Node.js 24)` section
(lines 49–271) — from the `## node:sqlite pitfalls (Node.js 24)` header up to
but **not including** the `## HTTP integration test patterns` header (line 273).

Replace it with a one-line cross-reference so a reader of `lang:node` knows where
the database guidance went:

```md
## node:sqlite / SQLite

SQLite, FTS5, and `node:sqlite` (`DatabaseSync`) pitfalls live in the `lang:sqlite` skill — inject it alongside `lang:node` for database tasks.
```

Rationale for keeping a stub `##` section rather than deleting cleanly: the
existing `gateLanguageGuidance` sqlite gate keys off a header containing
`sqlite`. Leaving a short `## node:sqlite / SQLite` header keeps the gate's
sqlite branch live and harmless — it gates a 2-line cross-ref instead of a 20K
block. The cross-ref is cheap enough that gating it in or out is immaterial, and
the HTTP/busboy gate sections below are untouched.

**HTTP section gating stays as-is.** `## HTTP integration test patterns`,
`## Test isolation — prefer factories over ESM cache busting`, and `## busboy v1`
remain in `lang:node` with their existing gate behavior. The HTTP section's gate
(`/express|node:http|http\.create|server\.listen|app\.listen/i`) is unaffected by
removing the SQLite section. Note: the `## Test isolation` section is **not**
SQLite content (it is generic ESM module-cache guidance) — it stays in
`lang:node`, and its test (`'lang:node accurately explains ESM URL caching'`)
stays put.

### 3. DatabaseSync import pitfall — recommendation: MOVE to `lang:sqlite`

The Import-name pitfall (`import { DatabaseSync } from 'node:sqlite'`) is
**node:sqlite specific**, but it belongs in `lang:sqlite`, not `lang:node`,
because:

- It is only ever relevant when the task touches SQLite — exactly the signal
  that injects `lang:sqlite`. Keeping it in `lang:node` would mean every
  non-database Node task carries it (it is in the gated section today, so it is
  already conditional on a SQLite-flavored task).
- The whole point of the extraction is "inject SQLite guidance for any
  SQLite task regardless of language." A Rust task that shells out to a Node
  helper using `node:sqlite`, or a Node task, both want the import pitfall; it
  travels with the database skill.
- Splitting it (import name in `lang:node`, everything else in `lang:sqlite`)
  would fragment one coherent topic across two files and reintroduce the
  duplication the extraction removes.

So the `DatabaseSync` import pitfall moves wholesale into `lang:sqlite`. There is
a separate, open idea in `NEXT.md` ("lang:node DatabaseSync in preamble —
training-prior override") about anchoring a one-liner in the `lang:node`
*preamble*; that is **not** part of Phase 257 and is not actioned here.

### 4. Rebuild the bundle

```
npm run build-skills
```

This regenerates `src/builtin-skills.json` with the new `lang:sqlite` entry and
the trimmed `lang:node` body. Commit the regenerated JSON. `npm run check`
includes `npm run build-skills -- --check`, which fails if the committed JSON is
stale — so the rebuild must be committed.

### 5. Move the SQLite tests — `test/builtin-skills.test.mjs`

These `it` blocks currently assert against `getBuiltinSkill('lang:node')`. Move
each to assert against `getBuiltinSkill('lang:sqlite')` and rename the `it`
title prefix from `lang:node` to `lang:sqlite`. The assertion regexes stay
identical (the content is byte-identical, only the host skill changed):

1. `'lang:node names the node:sqlite import as DatabaseSync, not Database'`
   → `'lang:sqlite names the node:sqlite import as DatabaseSync, not Database'`
2. `'lang:node warns that node:sqlite is synchronous — no await'`
   → `'lang:sqlite warns that node:sqlite is synchronous — no await'`
3. `'lang:node warns that shared SQLite test DB accumulates state and recommends beforeEach reset'`
   → `'lang:sqlite warns that shared SQLite test DB accumulates state and recommends beforeEach reset'`
4. `'lang:node warns that StatementSync rows are named-column objects, not arrays'`
   → `'lang:sqlite warns that StatementSync rows are named-column objects, not arrays'`
5. `'lang:node teaches the createApp(db) factory for db injection'` — **keep in
   `lang:node`**: this asserts `/Inject the DB/` and `/createApp\(db\)/`, which
   live in the **HTTP integration test patterns** section (lines 298–337), NOT
   the SQLite section. Verify before moving: the `createApp(db)` factory text is
   under `## HTTP integration test patterns`, so this test stays asserting
   `lang:node`. (Confirm during implementation: `grep -n 'createApp(db)'` against
   both files; it must remain in `lang:node`.)
6. `'lang:node warns that mixing FTS5 triggers and manual deletes corrupts the index'`
   → `'lang:sqlite warns that mixing FTS5 triggers and manual deletes corrupts the index'`
7. `'lang:node covers the FROM-base/WHERE-fts FTS5 MATCH failure form'`
   → `'lang:sqlite covers the FROM-base/WHERE-fts FTS5 MATCH failure form'`
8. `'lang:node documents correct external-content FTS5 trigger patterns'`
   → `'lang:sqlite documents correct external-content FTS5 trigger patterns'`

The prompt's task description named blocks 1, 2, 6, 7, 8 explicitly; blocks 3
and 4 also assert SQLite content (`SQLite test state reset`, `StatementSync row
access`) that moves to `lang:sqlite`, so they move too. Block 5 (createApp) is
HTTP-section content — do **not** move it.

Tests that **stay** asserting `lang:node` (their content is not SQLite):
`'...warns to check response status before JSON.parse'`,
`'...bans module-scope side effects'`,
`'...warns that node:test hooks must be async'`,
`'...teaches the createApp(db) factory'` (block 5 above),
`'...accurately explains ESM URL caching and recommends factories'`.

Add one new resolution test asserting the skill exists and is non-empty:

```js
it('getBuiltinSkill resolves lang:sqlite with a non-empty body', () => {
	const skill = getBuiltinSkill('lang:sqlite');
	assert.equal(skill.name, 'lang:sqlite');
	assert.ok(skill.body.length > 0);
});
```

### 6. Size guards — `test/system-env.test.mjs`

The three prompt-budget guards (`prompt budget guard` describe, ~line 346) and
the gateLanguageGuidance suite (~line 533) measure prompts built from
`lang:node`. Removing the ~20K SQLite block from `lang:node` will shrink the
Node/ESM and native-mode prompts dramatically. Do **not** lower the ceilings
blindly — run `npm test` first to read the new measured values, then:

- **Node/ESM auto-mode guard** (`< 22500`, line 396): now measures far lower
  (preamble + ESM/test/HTTP/busboy + a 2-line SQLite cross-ref). Set the ceiling
  to the next clean 500 above the new measured value and add a `// Phase 257:
  SQLite content extracted to lang:sqlite; lang:node prompt shrank to ~N chars`
  comment.
- **Native-mode guard** (`< 21500`, line 465): same treatment — re-measure,
  lower to next clean 500 above measured, add `// Phase 257` comment.
- **Non-Node guard** (`< 4000`, line 423): unaffected (no language block);
  re-run to confirm still green; no change expected.
- **Task-gating shrink assertion** (`gated < ungated * 0.6`, ~line 495): this
  compares a SQLite-flavored task prompt against a plain one. With the SQLite
  block gone from `lang:node`, the gated/ungated delta narrows. Re-run; if it
  fails because the remaining gateable delta (HTTP/busboy + cross-ref) is now
  under the 40% threshold, relax the ratio to a value the measured data supports
  (e.g. `* 0.85`) with a `// Phase 257` comment explaining the SQLite block left
  `lang:node`, or assert `gated.length <= ungated.length` instead. Decide from
  the measured numbers, not in advance.

The `gateLanguageGuidance` unit tests (lines 536+) build a synthetic `makeBody()`
fixture, not the real `lang:node` body, so they are **unaffected** by the move
and must stay green unchanged.

### 7. NEXT.md and roadmap

- Add to `roadmap.md` after line 251 (`- [x] 256 ...`):
  `- [ ] 257 Extract lang:sqlite skill from lang:node` (check the box on commit).
- Update NEXT.md `## Current frontier (phase 256)` heading to `(phase 257)` and
  append a sentence: `Phase 257 extracts the SQLite/FTS5 pitfalls into a
  standalone lang:sqlite skill so they can be injected independently of
  lang:node.`
- No NEXT.md candidate item is consumed by this phase (there was no pre-existing
  `lang:sqlite` extraction candidate). Phase 258 (widen auto-injection to a
  secondary skill) is the natural follow-up — add a one-line NEXT.md candidate
  for it if not already present:
  `### Auto-inject a secondary language skill (lang:sqlite alongside lang:node)`
  describing that context-packer's scalar detectedLanguage needs to become a
  list so a SQLite-flavored task pulls lang:sqlite in addition to the primary
  language skill.

### 8. Version bump

Bump `package.json` `"version"` `0.0.256` → `0.0.257`. `npm run cversion`
(`bin/cversion.mjs --check`, run inside `npm run check`) enforces the version
matches the highest phase; the bump is mandatory.

### 9. Process + blog

- `process/decisions.jsonl`: one entry recording the decision to extract
  `lang:sqlite` as a standalone skill, that the `DatabaseSync` import pitfall
  moved with it (rationale: travels with the database topic, injected for any
  SQLite task), that `lang:node` keeps a 2-line cross-ref stub, and that gating
  for `lang:sqlite` is unnecessary (whole skill on-topic). Note auto-injection
  wiring deferred to Phase 258.
- Blog post `blog/257-lang-sqlite-skill-extraction.md`: why the ~22K `lang:node`
  file was split, how the bundle auto-discovers the new skill, and the
  size-guard movement (Node prompt shrank). Capture the harness/process angle
  per AGENTS.md ("Blog posts should capture important harness and app failures
  discovered during the phase") — at minimum the prompt-size regression that
  motivated the split.

## Done criteria

- [x] `src/builtin-skills/languages/sqlite/SKILL.md` created with frontmatter
      `name: lang:sqlite`, a SQLite-specific `# node:sqlite / SQLite Contract`
      preamble, and **all** SQLite/FTS5 pitfall content moved verbatim from
      `lang:node` (import name, synchronous, BigInt bind, DEFAULT, `:memory:`,
      FTS5 MATCH syntax, FROM-base/WHERE-fts form, FTS5 trigger vs manual sync,
      external-content FTS5 triggers, createDatabase factory, SQLite test state
      reset, StatementSync row access).
- [x] `lang:node` SKILL.md `## node:sqlite pitfalls (Node.js 24)` section
      removed and replaced with a 2-line `## node:sqlite / SQLite` cross-ref to
      `lang:sqlite`. HTTP / Test-isolation / busboy sections untouched.
- [x] `DatabaseSync` import pitfall lives in `lang:sqlite` (moved, not split).
- [x] `bin/build-skills.mjs` picks up the new skill automatically (no builder
      edit); `src/builtin-skills.json` rebuilt via `npm run build-skills` and
      committed.
- [x] SQLite-related tests in `test/builtin-skills.test.mjs` (blocks 1, 2, 3, 4,
      6, 7, 8 above) moved to assert `getBuiltinSkill('lang:sqlite')` with
      renamed `it` titles; createApp test (block 5) and ESM-cache / status /
      side-effects / hook-async tests stay on `lang:node`.
- [x] New `'getBuiltinSkill resolves lang:sqlite with a non-empty body'` test
      passes.
- [x] `test/system-env.test.mjs` size guards re-measured and lowered to the next
      clean 500 above measured for Node/ESM auto and native modes, with
      `// Phase 257` comments; non-Node guard confirmed green; the
      gated-vs-ungated shrink assertion adjusted to the measured data if it
      regresses; gateLanguageGuidance synthetic-fixture unit tests unchanged.
- [x] `npm run format`, full `node --test` suite, and `npm run check` (incl.
      `build-skills --check` and `cversion --check`) all clean.
- [x] `process/decisions.jsonl` entry recorded.
- [x] Blog post `blog/257-lang-sqlite-skill-extraction.md` added.
- [x] `roadmap.md` line `- [x] 257 Extract lang:sqlite skill from lang:node`
      checked; NEXT.md frontier updated to phase 257 and a Phase-258
      auto-injection candidate noted.
- [x] `package.json` version bumped to `0.0.257`.
- [x] Commit captures the phase.
