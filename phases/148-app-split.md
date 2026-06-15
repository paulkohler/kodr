# Phase 148 — Split `app.mjs` into a Dispatcher + Command/Pipeline Modules

## Motivation

`app.mjs` is 5,806 lines — ~22% of `src/` in one file. It welds together three
unrelated concerns (see `docs/ARCHITECTURE.md`): CLI arg-parsing/usage, a ~22-way
subcommand dispatch (`main()`'s `if (command === 'X')` chain), and the ~2,800-line
`runPrompt` core pipeline — plus renderers, `handleChannelRequest`, and
`parseManagementInstances`. It is the single biggest drag on legibility and the
top simplification lever identified in the architecture review.

This phase is a **pure, behavior-preserving refactor**: move cohesive concerns
into modules along the tier map, leaving `app.mjs` a thin entry point. No logic
changes, no feature changes. The 1,418-test suite is the safety net.

## Design principles

1. **Zero behavior change.** Every commit is a move + import rewiring. If a test
   needed editing for any reason other than an import path, the move changed
   behavior and is wrong.
2. **Preserve the public import surface.** 13 test files import from `app.mjs`
   (`parseArgs`, `runPrompt`, `main`, `handleChannelRequest`, `CliError`,
   `usage`, `renderSession*`, `parseManagementInstances`,
   `extractPromptFilePaths`, …). `app.mjs` must **re-export** every symbol it
   moves out, so no test import changes. (No `src/` module imports from
   `app.mjs`, so extraction is one-directional — no circular-dependency risk.)
3. **One concern per commit, suite green after each.** Run `npm test` +
   `npm run check` after every extraction; small commits per the constitution.
4. **Easiest first, riskiest last.** Pure helpers → leaf command handlers →
   arg-parsing → the core pipeline. Stop and split into a follow-up phase if the
   `runPrompt` helper web proves too tangled to move safely in one pass.

## Target layout

```
src/
  app.mjs                 # thin: parseArgs → dispatch → handler; re-export barrel
  cli/
    args.mjs              # parseArgs + usage (help text)
    dispatch.mjs          # main(): route command → handler (or keep in app.mjs)
  commands/
    forensics.mjs         # why, trends, route, evals
    evals.mjs             # eval (run an evalset)  [or fold into forensics]
    bench.mjs             # bench
    compare.mjs           # compare
    replay.mjs            # replay, cycle-review
    session.mjs           # session list/show/export, prompt-history
    undo.mjs              # undo
    inspect.mjs           # inspect, registry
    skills.mjs            # skills, probe, init
    serve.mjs             # serve, watch
  run-pipeline.mjs        # runPrompt + its private helpers (the Tier-1 core)
  render/
    session.mjs           # renderSessionList/Conversation/Markdown, renderSkillsListing
```
(Exact module boundaries may merge thin handlers; `parseManagementInstances`
moves to `model-profiles.mjs` where it belongs — it parses the LM Studio
management API.)

## Work items (each a separate commit; suite green after each)

### Stage A — pure helpers / renderers (lowest risk)
Move `renderSessionList`, `renderSessionConversation`, `renderSessionMarkdown`,
`renderSkillsListing` → `src/render/session.mjs`; `extractPromptFilePaths` →
near its only caller; `parseManagementInstances` → `model-profiles.mjs`. These
are pure, already exported, and directly unit-tested. `app.mjs` re-exports them.

### Stage B — leaf subcommand handlers
Lift each `if (command === 'X')` block whose body only orchestrates other modules
into `src/commands/*.mjs`: `why`/`trends`/`route`/`evals`, `bench`, `compare`,
`replay`/`cycle-review`, `session`/`prompt-history`, `undo`, `inspect`/`registry`,
`skills`/`probe`/`init`, `serve`/`watch`. `main()` calls the extracted handler.
Each handler keeps its exact I/O contract.

### Stage C — arg parsing & usage
Move `parseArgs` + `usage` → `src/cli/args.mjs`; re-export from `app.mjs`.

### Stage D — the core run pipeline (the big one; do last, with care)
Move `runPrompt` and its private helpers → `src/run-pipeline.mjs`. This is ~2,800
lines with a dense web of local helpers; extract the helpers alongside it.
Re-export `runPrompt` from `app.mjs`. **If the helper coupling is too tight to
move safely in one commit, stop and carve this into its own follow-up phase
(149)** — Stages A–C already deliver most of the legibility win and leave a much
smaller, clearer seam around `runPrompt`.

### Stage E — slim `app.mjs`
What remains: the entry point, `main()` as a thin router, the re-export barrel,
and the error classes. Target ≤ ~800 lines.

## Testing

- `npm test` after every stage — the existing suite is the behavior oracle; it
  must stay green at every commit with **no test edits** (only the re-export
  barrel keeps imports valid).
- `npm run check` (syntax + version + skills) and `npm run format` each stage.
- No new tests are required (pure refactor), but add a small guard test asserting
  `app.mjs` still re-exports the documented public surface, so a future move that
  drops a re-export fails loudly.

## Out of scope (NEXT.md, not here)

- **Lever #2 — make Tier 4 opt-in / lazy-load** (orchestration, sandboxes, LSP,
  MCP, web server should not load on a bare `run`/`chat`). Separate phase; do it
  after the seams from this split exist.
- Any logic, feature, or output change. Pure structure only.

## Done criteria

- [ ] `app.mjs` reduced to a thin entry/dispatcher + re-export barrel
      (target ≤ ~800 lines), or Stages A–C done with D deferred to phase 149.
- [ ] Each extracted module is single-concern and < ~600 lines.
- [ ] Full suite green after every commit; **no test import churn** (verified by
      the re-export guard test).
- [ ] `npm run check` + `npm run format` green.
- [ ] `docs/ARCHITECTURE.md` updated to the new file layout.
- [ ] `process/decisions.jsonl`: the re-export-barrel strategy (preserve the
      `app.mjs` import surface; one-directional extraction).
- [ ] Blog post `blog/148-app-split.md` capturing the before/after and any
      surprises (e.g. helpers that turned out to be shared across tiers).
- [ ] Roadmap line checked; version bumped to 0.0.148; committed.
```
