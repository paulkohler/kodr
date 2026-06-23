# The Import That Keeps Coming Back

Three separate dogfood phases. Three separate model runs. Each time, a SQLite task
prompt. Each time, the model writes:

```js
import { Database } from 'node:sqlite';
```

`Database` does not exist. The correct form is `DatabaseSync`. The error is
immediate and hard:

```
TypeError: The "database" argument must be an instance of DatabaseSync.
```

## Why the existing pitfall doesn't land

Phase 255 expanded the Import Name pitfall in the SQLite section of `lang:node`.
Phase 257 extracted `lang:sqlite` as a standalone skill and made it the definitive
home for SQLite knowledge. The pitfall was thorough: it listed every wrong form
(`Database`, `open`, the default export), explained that `node:sqlite` exports
exactly one symbol (`DatabaseSync`), showed the wrong import and the correct import
side by side.

The problem is not the pitfall's content. The problem is where it lives.

The SQLite section is gated. It only fires when the task prompt matches
`SQLITE_TASK_PATTERN`. The section is also long — over 20 KB by phase 258. A model
processing a prompt sees the preamble, then the first few sections, then progressively
more context. By the time the Import Name pitfall arrives, the model has already
decided how to write the imports.

Training prior for `node:sqlite` is `Database` — that is what the internet shows.
The correct form (`DatabaseSync`) is unusual enough that the model's prior fights
every correction that isn't directly in front of it at generation time.

## Why preamble placement works

Phase 256 had the same problem with `node:test` hook callbacks: the model kept
writing `before((done) => { ... })` despite a hook-async pitfall in the lang:node
skill. Moving the pitfall to the preamble — the first lines of the skill, before
any `##` header — stopped the done-callback failure immediately. The preamble is
always rendered, never gated. It appears near the top of the prompt. The model
sees it before generating any code.

The same logic applies to DatabaseSync.

## What was added

One line in the preamble of `src/builtin-skills/languages/node/SKILL.md`:

```
- node:sqlite — `import { DatabaseSync } from 'node:sqlite'` is the only correct
  form. `Database`, `open`, and the default export do not exist. All methods are
  synchronous — never use `await` on db calls.
```

Placed after the CLI argv bullet and before the ANSI truncation bullet — the
existing preamble section, before any `##` header. It fires on every Node/ESM
prompt regardless of whether the SQLite gate section fires. The full pitfall detail
stays in `lang:sqlite`; this is the anchor that prevents the training prior from
winning on first sight.

The `npm test` assertion verifies that `DatabaseSync` appears in the body before
the first `\n## ` marker, so any future edit that accidentally moves the anchor
below a section header will fail the test.

## What's next

The anchor is in place. Whether it actually suppresses the `Database` import on
cold runs is an empirical question — the dogfood will tell. If the model still
misses it, the next lever is to make the import line even more salient: a bold
header, a code fence, or a dedicated "WRONG IMPORT FORMS" list at the very top.
