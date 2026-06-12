# Phase 109: Dogfood Harness Fixes

## Goal

Fix the harness bugs surfaced by the first dogfooding round (`process/failures.jsonl`, phase `109-dogfood`). Two real runs against `qwen/qwen3.6-35b-a3b` — a brownfield bug fix and a greenfield generation — exposed failures in the tool loop, the failure-path artifacts, and the forensics surface. This phase fixes the crisp ones; the open design questions stay in `NEXT.md`.

## Background

In the brownfield test the model read the files, correctly diagnosed the planted bug, then tried to apply the fix via `run_command` (`sed -i`, `node --eval`). The allowlist correctly blocked those, the model re-ran the failing test until `turn_budget_exhausted`, and the run hard-failed with all eight turns of conversation and usage discarded from artifacts. Forensics then reported "Model Call: ok", and bare `kodr why` failed because `.kodr/last-run` is only written on success. The greenfield test added: `kodr why <relative-path>` silently double-prefixes, and repair context contained a ghost empty file.

## Fixes

### F1 — Tool-loop write steering and no-progress (src/tool-calls.mjs)

- When `run_command` rejects a non-allowlisted command, append steering to the error tool result: the harness has no write tool; file changes must be returned in the final JSON proposal (`files` array), not applied via commands.
- Track tool calls by `name + canonical args` within a run. When the model repeats a tool call already made, skip execution and return a synthetic result saying the call is a repeat and that it should stop calling tools and return the final proposal.
- Final-turn forcing: when the budget allows exactly one more turn, send that request without `tools` and append a user message instructing the model to return the final JSON proposal now. Budget exhaustion becomes a final answer instead of an error.

### F2 — Salvage artifacts on budget exhaustion (src/tool-calls.mjs)

If `beforeTurn` still throws inside `completeWithToolCalls`, catch the `LoopBudgetError` and return a normal completion shape — accumulated `responses`, `finishReasons`, `messages`, `loopBudget` with its stop reason, and the last assistant text (may be empty) — instead of propagating. Downstream proposal extraction and artifact writing then run normally; no conversation or usage is lost.

### F3 — last-run pointer on failure (src/app.mjs)

Write `.kodr/last-run` on the failure path too, so bare `kodr why` analyzes the run that just failed.

### F4 — Honest Model Call step in forensics (src/forensics.mjs)

`buildCausalStory` must not report Model Call `ok` when the summary says the run failed and no responses were recorded, or when `error.json` holds a loop/model error. Load `error.json` in `loadRunAnalysis` if not already loaded, and classify the step `fail` with the error message as detail.

### F5 — kodr why path resolution (src/forensics.mjs)

`resolveRunDir`: an argument containing a path separator resolves against cwd (not under `.kodr/runs/`). When the resolved directory contains none of the known run artifacts, throw a clear error instead of rendering an all-skip story.

### F6 — No ghost files in repair context (src/healing.mjs)

`buildRepairContext` must only include files that exist and are readable. Paths inferred from test output that do not exist on disk are skipped, never included with empty content.

### F7 — workspaceFileCount in tools mode (src/app.mjs / src/context-packer.mjs)

Count `fileMap` entries when the packed `files` list is empty so `summary.workspaceFileCount` stops reporting 0 for every tools-mode run.

## Added during the phase: the test suite was part of the harness too

Completing the phase required a green `npm test`, and the suite itself turned
out to have two pre-existing defects, both confirmed unrelated to this phase's
diff (the watcher failure reproduces at HEAD; the hang matched a previously
observed `npm test` that never exited):

- **F8 — LSP child leak (src/lsp-client.mjs).** `runLspInspector` spawned the
  language server, then let an `initialize` timeout propagate without killing
  the child. The orphan kept the test process's event loop alive forever — and
  with `--test-timeout=0` the whole suite hung on `lsp-client.test.mjs` even
  though every test in it passed. The same leak would orphan a real hanging
  language server in `lsp: auto` runs. Fix: kill the client before rethrowing.
- **F9 — watcher test race (test/watcher.test.mjs).** macOS FSEvents delivers
  an event for the freshly created watch root itself; the test asserted on the
  first debounced batch and failed deterministically on this machine. Fix: the
  test waits for the specific file. Product behavior is unaffected.

## Out of scope (stays in NEXT.md)

- Repair-call timeout strategy (repair prompts reliably hitting the 600s wall).
- Gating apply on detected wrong-path repairs (phase 103 design question).
- Whether qwen3.6's model profile should default `nativeToolCalls` off.

## Done criteria

- [x] F1: steering message on blocked write-like commands, repeat-call short-circuit, final-turn forcing without tools
- [x] F2: `completeWithToolCalls` returns salvaged completion on budget exhaustion
- [x] F3: `.kodr/last-run` written on failed runs
- [x] F4: forensics Model Call step reports failure honestly
- [x] F5: `kodr why` resolves path-like args against cwd and errors on non-run dirs
- [x] F6: repair context excludes nonexistent files
- [x] F7: `workspaceFileCount` counts fileMap in tools mode
- [x] F8/F9: test-suite hang (LSP child leak) and watcher test race fixed
- [x] node:test coverage for each fix
- [x] `npm run format`, `npm test`, `npm run check` clean
- [x] Re-run the brownfield dogfood test; record the outcome (fixed or new failure shape) in `process/failures.jsonl` — fixed end-to-end: 7 tool turns, forced final proposal turn, correct patch, verification green
- [x] Blog post
- [x] Roadmap + version bump
- [x] Commit
