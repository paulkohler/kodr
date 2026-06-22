# Phase 247: System Prompt Hardening

An Opus model reviewed the live 14k-char system prompt against six months of
dogfood failures. Four changes ship now; one large architectural item goes to
NEXT.md.

## The structural problem

The Node/ESM skill body is ~11k chars — roughly 78% of the total prompt. Every
behavioural rule the model needs to follow sits below this wall of SQLite and HTTP
recipes. The high-value guidance is invisible.

Fixing the proportion (task-gating the SQLite/HTTP sections to only appear when
the task actually touches them) is the highest-leverage change and goes to NEXT.md
as a planned phase. Everything below is a targeted wording fix.

## 1. package.json rule in Behaviours

The staged dogfood wrote `import express from 'express'` without ever writing
`package.json`. No `package.json` → no npm install → 100% test failures.

There was literally zero mention of third-party dependency declaration anywhere in
the prompt. Added to `renderBehavioursBlock()`:

```
When you import a third-party package, declare it in `package.json` `dependencies`
in the same response — never import a package that has no `package.json` entry.
```

## 2. Staged-execution qualifier on the envelope rule

`renderBehavioursBlock()` said "Return exactly ONE JSON envelope per response,
containing the COMPLETE files/patches for the task." The staged pipeline's stage
prompt says "implement one coherent slice only." These directly contradict.

The model sees "do it all" from the system prompt and "do a slice" from the user
prompt. The tension contributes to premature STAGED_DONE and slice-skipping.

Updated to: "…In staged execution, complete only the current stage slice; the
harness will prompt for the next stage."

## 3. read_file made imperative

The old description was:

```
- `read_file` — raw file text; read before you patch.
```

"Read before you patch" is advice, not an instruction. The model skips it
constantly. The new wording:

```
- `read_file` — raw file text. Read every existing file before you edit or
  patch it — never patch a file you have not read this turn.
```

"Never patch a file you have not read" is a constraint, not a suggestion.

## 4. Auto mode prefers tool calls

The `auto` channel description said "both channels work; the harness merges them."
This is technically true but actively invites the model to use both — which means
the same write appears twice and the harness has to deduplicate.

New wording:

```
Prefer write_file/edit_file tool calls for all file changes. Keep the final JSON
envelope for status and messages; leave its files/patches arrays empty if you used
the tools. Do not emit the same write through both channels.
```

Also replaced the passive "Workflow: inspect → read → write_file" arrow with an
explicit numbered sequence:

```
Required order: 1) inspect_symbols to orient, 2) read_file every file you will
touch, 3) write_file/edit_file. Skipping step 2 produces wrong patches.
```

## What goes to NEXT.md

**Task-gating the SQLite/HTTP lang:node recipes.** The `detectNodeEsm` signal
fires on any `.mjs` file, unconditionally including 11k chars of SQLite pitfalls
in a string-utils prompt. Fixing this requires per-section detection (does the
task text or the imported modules reference `node:sqlite`? express?) rather than
a binary Node/not-Node flag. Worth a dedicated phase.
