# Phase 243: lang:node Skill — StatementSync Row-Access Pitfall

During the phase-242 ambitious audit the task was a SQLite notes REST API. The model wrote
`r[0]`, `r[1]`, `r[2]` to read columns from `StatementSync.all()` rows. Two of seven tests
failed because `r[0]` is always `undefined` — `node:sqlite` returns plain named-column objects
(`{ id, title, body }`), not arrays. There is no numeric index.

The real damage came from the heal loop. Rather than notice the API-shape mismatch, the model
burned 4094 of 4096 reasoning tokens hypothesising that the database was being reset between
operations. It hit the token cap in a loop, triggered `reasoning_runaway`, and gave up without
a fix. The root cause was never reached because the model did not know the API convention.

## Why the skill didn't catch it

The `lang:node` SKILL.md already had six `node:sqlite` pitfalls: wrong import name
(`Database` vs `DatabaseSync`), BigInt bind, DEFAULT expression, `:memory:` in tests, FTS5
MATCH syntax, and the `createDatabase` factory. None of them described the return shape of
`StatementSync.all()` or `stmt.get()`. The model defaulted to array indexing, which is
correct for some other SQLite libraries, and the skill offered no correction.

## What was added

A seventh pitfall block — **StatementSync row access** — placed after the createDatabase
factory block inside the existing `## node:sqlite pitfalls (Node.js 24)` section:

```
StatementSync row access — stmt.all() and stmt.get() return named-column objects,
not arrays. row[0] is always undefined. Use row.columnName.
```

The block includes a wrong/correct pair:

- Wrong: `const title = rows[0][1];` (undefined — no numeric index)
- Correct: `const title = rows[0].title;` (named column access)
- Also correct: `const id = row.id;` for a single `stmt.get()` result

## The test catch

A new test in `builtin-skills.test.mjs` asserts four things about the `lang:node` body:
the `StatementSync row access` heading is present, the phrase `named-column objects` appears,
`row.columnName` appears as the corrective pattern, and `rows[0][1]` appears as the
wrong-pattern example. The last assertion caught a typo in the initial test draft: the
wrong-pattern variable in the skill code is `rows` (plural), not `row`, so the regex had to
be `/rows\[0\]\[1\]/` not `/row\[0\]\[1\]/`.

## Budget impact

The system prompt for a Node/ESM greenfield task grew from approximately 12626 to 13252 chars
in auto mode, and from 11551 to 12189 chars in native mode. Both remain within the existing
14000 and 13000 budget guards set in phase 238. The comments in `system-env.test.mjs` were
annotated with the phase 243 actuals.
