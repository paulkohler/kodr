# Phase 155: Making File-Author Isolation Real

Phase 92 split the implementer into *isolated file-authors*: when the planner emits
a structured manifest, Kodr spawns one subagent per file, each handed a contract
(its path, responsibility, exports, imports) and the *export signatures* of its
siblings — never their bodies. The point is parallel-safe, context-light authoring:
each agent does one file and only one file.

The phase-154 retest found it wasn't doing that. A two-file cross-dependency task
(`src/math.mjs` exporting `add`/`sub`; `src/calc.mjs` importing them and exporting
`calc`) produced a *correct* result — but both authors wrote *both* files.
`author-0`, whose contract was `src/math.mjs`, returned `[math.mjs, calc.mjs]`. So
did `author-1`, whose contract was `src/calc.mjs`. The merge deduped them into the
right two files, so nothing looked wrong — while the model did the whole job twice
and the "siblings as signatures only" guarantee meant nothing, because each author
reconstructed the siblings from scratch anyway.

## The cause

`renderFileAuthorUserPrompt` led every author's prompt with the raw task:

```
Create two ES modules: src/math.mjs … src/calc.mjs …
## Plan summary
…
## Your file contract
**Path:** src/math.mjs
…
```

The contract said "one file." The task above it said "create two." The model obeyed
the louder, earlier, imperative instruction and built everything. The fix isn't
subtle prompt-tuning — it's removing the contradiction.

## The decision: drop the raw task, don't trim it

There was a real fork here: keep the full task as "context" (zero risk of losing a
global constraint buried in the prose), or drop it (clean isolation, but lean on the
plan summary to carry the intent). The probe settled it. The planner's
`## Plan summary` already digests the task faithfully —

> Create two ES modules in src/: math.mjs exports add(a,b) and sub(a,b); calc.mjs
> imports those from ./math.mjs and exports calc(op,a,b) …

— so the raw task is *redundant* with the summary, and it's the redundant copy that
causes the bleed. A file-author is by design an isolated single-file agent; handing
it the whole task contradicts its own purpose. Global constraints (ESM, async,
style) are the planner's job to carry into the summary and per-file
responsibilities. If one ever leaks, that's a planner bug to fix at the source — far
cleaner than re-dumping the entire task on every author and hoping the contract wins.

So the lead became an unambiguous scope directive:

> **## Your assignment**
> Write exactly one file: `src/math.mjs`. Implement only this file, working from its
> contract below. Do not create, modify, or re-emit any other file — the plan's
> other files are written by separate authors and appear here only as context
> (their export signatures). Your proposal must contain this path and nothing else.

The plan summary, contract, sibling signatures, and any file-author directives all
stay. The non-isolated implementer path is untouched — it owns the whole plan and
*should* see the whole task.

## Before / after, on two models

The "before" was already on record from the phase-154 probe. The "after," same
cross-file task, `--subagent-stages --yes`:

| | author-0 (contract: math.mjs) | author-1 (contract: calc.mjs) |
|---|---|---|
| **Before** | `[math.mjs, calc.mjs]` | `[math.mjs, calc.mjs]` |
| **After — qwen** | `[math.mjs]` | `[calc.mjs]` |
| **After — gpt-oss** | `[math.mjs]` | `[calc.mjs]` |

Both an envelope model (qwen) and a tool-only model (gpt-oss) now write exactly
their contracted file. `ok=true`, `writeCount=2`, `reviewPass=true`, and the merged
`calc.mjs` still imports `add`/`sub` from `./math.mjs` correctly — the coordination
that always worked is intact, now without the redundant double-authoring.

Full suite 1,481 green (+1 scope test that fails if the multi-file task ever leaks
back into the file-author prompt).
