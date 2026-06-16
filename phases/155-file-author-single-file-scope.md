# Phase 155 — File-Author Single-File Scope

## Motivation

The phase-154 retest (`process/failures.jsonl` `154-investigation`) found the
isolated file-author path (phase 92) does not actually isolate. A qwen
`--subagent-stages` run on a two-file cross-dependency task produced **correct**
output, but **both** authors wrote **both** files: `author-0` (contract:
`src/math.mjs`) and `author-1` (contract: `src/calc.mjs`) each returned
`[math.mjs, calc.mjs]`. `mergeProposals` dedups to a correct result, so it passes
silently while doing N× the authoring and giving no real isolation.

Cause (verified from artifacts + code): `renderFileAuthorUserPrompt`
(`orchestration.mjs:795`) leads each author's user prompt with `parsed.basePrompt`
— the **full multi-file task** ("Create two ES modules … src/math.mjs …
src/calc.mjs …"). That imperative enumeration dominates the model over the later
`## Your file contract` (single path) and the SKILL.md "write only your contracted
file." The author implements the whole task.

## Fix

In `renderFileAuthorUserPrompt`, drop the raw `parsed.basePrompt` lead and replace
it with an explicit single-file scope directive naming the contracted path.
Everything that an isolated author legitimately needs stays:

- `## Your assignment` (new): "Write exactly one file: `<path>`. … Do not create,
  modify, or re-emit any other file — siblings are written by separate authors and
  appear only as context. Your proposal must contain only this path."
- `## Plan summary` (`manifest.summary`) — the planner's faithful digest of the
  global intent (the probe confirmed it carries the task's substance), so the raw
  task is redundant; this remains the global-context channel.
- `## Your file contract`, `## Sibling export signatures`, `## Existing file
  content` — unchanged.
- File-author directives (`splitAgentDirectives`) — unchanged (parsed separately
  from `basePrompt`).

Rationale: a file-author is by design an isolated single-file agent; feeding it the
whole task contradicts its purpose. Global constraints are the planner's job to
carry into the summary/responsibilities — if one ever leaks, the fix belongs in the
planner, not in re-dumping the task on every author. The non-isolated implementer
path (`renderAgentUserPrompt('implementer', …)`) is untouched — it handles the whole
plan and *should* see the full task.

## Testing

- Unit (`orchestration.test.mjs`): a multi-file `basePrompt` is NOT echoed into the
  file-author prompt; the single-file scope directive names the contracted path;
  plan summary + sibling signatures still present; existing "no sibling bodies"
  guarantee preserved.
- Live before/after (AGENTS.md): re-run the phase-154 cross-file probe on **qwen**
  and a **tool-only model (gpt-oss)**. Each author must write **only** its
  contracted file; the merged result stays correct.

## Done criteria

- [x] `renderFileAuthorUserPrompt` leads with a single-file scope directive; raw
      multi-file `basePrompt` no longer included.
- [x] Unit test asserts the scope (no multi-file bleed, directive names the path,
      plan summary + sibling signatures retained).
- [x] `npm run format` + `npm run check` + full suite green (1,481 — +1).
- [x] Live qwen + gpt-oss before/after: each author writes only its file. Before
      (phase-154 probe): author-0 and author-1 each returned `[math.mjs, calc.mjs]`.
      After: qwen author-0 `[math.mjs]` / author-1 `[calc.mjs]`; gpt-oss (tool-only)
      identical scoping, status OK. Both `ok=true`, writeCount 2, reviewPass true,
      calc.mjs imports `./math.mjs` correctly — merged result preserved.
- [x] Blog `blog/155-*`; decisions entry; NEXT.md item resolved; roadmap line;
      version 0.0.155.
