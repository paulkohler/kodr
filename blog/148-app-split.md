# Phase 148: Splitting `app.mjs` Into a Dispatcher + Modules

`app.mjs` had grown to 5,806 lines — ~22% of `src/` in one file. The
architecture review (`docs/ARCHITECTURE.md`) named it the single biggest drag on
legibility: it welded together CLI arg-parsing, a ~22-way subcommand dispatch,
and the ~2,800-line `runPrompt` pipeline, plus renderers and the channel.

This phase is a **pure, behavior-preserving refactor**. No logic changed. The
1,431-test suite was the oracle: it had to stay green after every commit with
**zero test edits**, enforced by a guard test (`test/app-exports.test.mjs`) that
pins the public import surface. The whole phase ran in small commits across five
stages.

## The one rule that made it safe: the re-export barrel

13 test files and the channel handlers import from `app.mjs` (`parseArgs`,
`runPrompt`, `main`, `handleChannelRequest`, `CliError`, `renderSession*`, …).
The contract: every symbol that moves out is **re-exported** from `app.mjs`, so
no importer changes. And extraction is strictly one-directional — no `src/`
module imports from `app.mjs` — so there is no circular-dependency risk, as long
as anything shared between the dispatcher and a moved module goes to a *neutral*
third module instead of being imported back across the seam.

## The five stages

- **A — pure renderers + the management parser.** `renderSession*` /
  `renderSkillsListing` → `src/render.mjs`; `parseManagementInstances` →
  `model-profiles.mjs` (where it belongs — it parses the LM Studio API).
- **B — leaf command handlers.** Each `if (command === 'X')` body became
  `src/commands/X.mjs`: forensics (`why`/`trends`/`route`/`evals`), `inspect`/
  `registry`, `replay`/`cycle-review`, `session`/`prompt-history`/`undo`,
  `bench`, `serve`/`watch`, `compare`, `probe`, `skills`, `init`, `eval`.
  Prerequisite: `CliError`/`NativeNoProposalError` → `src/cli-errors.mjs` so
  command modules can throw without importing `app.mjs`. Handlers that need the
  channel or `runPrompt` take them as **injected parameters** rather than
  importing app — keeping extraction one-directional.
- **B+ — shared CLI input helpers.** `loadPrompt`, `workspaceContextOptions`,
  `resolved{Skills,Agents}Dirs` were used by *both* commands and the core
  pipeline, so they went to `src/cli/options.mjs` (neutral). This unblocked
  `compare`/`skills` and thinned the pipeline ahead of Stage D.
- **C — arg parsing.** `parseArgs` + `assignValue` + the option validators +
  `usage` → `src/cli/args.mjs`, with the default constants in
  `src/cli/defaults.mjs` (so both the parser and the pipeline import them
  without circularity).
- **D — the core pipeline.** `runPrompt`, `runStagedPrompt`, and ~35 private
  helpers → `src/run-pipeline.mjs`.

Result: **`app.mjs` 5,806 → 498 lines** — a thin dispatcher (imports/re-exports,
`main()`, `handleChannelRequest()`, `listSessions()`, the CLI approver/progress
helpers). Every extracted module is single-concern; `run-pipeline.mjs` is the
one large file left (~2,980 lines), and now it has a clean seam.

## What made Stage D tractable (and where it nearly bit)

The fear with `runPrompt` was a dense web of shared helpers. The actual coupling
turned out to be tiny: a usage analysis partitioning every imported symbol into
*head-only* / *pipeline-only* / *both* showed only **one** function crossing the
boundary both ways — `maybeCommitAppliedWrites`, used by `handleChannelRequest`
(stays) and the pipeline (moves). Resolution: it lives in the pipeline, and
`app.mjs` imports it back. One-directional, no cycle. The head imports back
exactly five symbols (`runPrompt`, `renderRunSummary`, `createInspectionContext`,
`verificationCwd`, `extractPromptFilePaths`).

Two harness lessons from doing the move mechanically:

- **`async function` blind spot.** My first function-boundary scan used
  `^(export )?function` and silently missed `async function maybeCommitAppliedWrites`,
  which sits *between* `usage` and the next helper. I almost sliced a
  git-commit helper into `cli/args.mjs`. A grep of the candidate range for
  *function calls* (not declarations) surfaced `buildCommitMessage`/
  `commitAppliedWrites` where they had no business being — the tell that the
  boundary was wrong. Lesson: when slicing by line range, verify by what the
  slice *references*, not just where the declarations appear.
- **Word-count false positives.** Classifying imports by `\bsymbol\b` counts,
  `usage` showed up as used in the pipeline (a local `const usage` for token
  stats) and `createChatCompletion` showed up as used in the head — but the
  latter was **only in a comment**. Both would have produced wrong import lists.
  A non-comment-line filter caught them. Final check: a script confirmed **zero
  unused imports** in either `app.mjs` or `run-pipeline.mjs`, and the partition
  was exact (no missing imports — the suite would have thrown otherwise).

## Verification

`npm test` (1,431) green and the 13-assertion export guard green after **every**
one of the ten commits, with no test edits. `npm run check` + `npm run format`
clean throughout. A live end-to-end smoke run against the local model confirmed
the real CLI path (parseArgs → dispatch → `runPrompt` → extraction → artifacts)
still works post-split.

## What this buys

The "too complex" feeling the architecture review diagnosed was the god-file,
not the research mission. With the seams in place, the next lever —
making Tier-4 capabilities (orchestration, sandboxes, LSP, MCP, web server)
lazy-load instead of importing on a bare `run` — now has clear module
boundaries to hang off, instead of a 5,800-line wall.
