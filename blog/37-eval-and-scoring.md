# Phase 37: Eval And Scoring

Phase 37 adds `kodr eval`, a command that runs an eval suite against a model
and scores the results. The phase-34 todo-cli test bug was caught by manual
inspection; this phase makes that systematic.

## What changed

**`src/eval.mjs`** is a new module. Three public exports:

**`loadEvalSuite(text)`** parses and validates a JSON suite file. Each suite
has a `name`, a `description`, and a `cases` array. Each case has an `id`,
a `prompt`, and an `assertions` array. Unknown assertion types and missing
required fields are caught at load time with `EvalError`.

**`runAssertion(assertion, proposal, timeoutMs)`** checks a single assertion
against a proposal object (the structured JSON output from `extractProposal`).
The three built-in types:

- **`files_exist`**: checks that all listed paths appear in
  `proposal.files` or `proposal.patches`. Fails gracefully if the proposal
  is null.
- **`content_matches`**: checks that a file's content in `proposal.files`
  matches a regex pattern. Reports a clean error if the pattern is invalid.
- **`tests_pass`**: writes all proposal files to a temp dir and runs the
  specified command there via `runVerification`. Cleans up the temp dir
  after (success or failure). Catches the phase-34 test-bug pattern
  directly — if the generated tests have a bare await on a non-zero-exit
  process, the tests fail, and this assertion returns `ok: false`.

**`scoreCase(evalCase, proposal, timeoutMs)`** runs all assertions for a
case sequentially and returns `{ ok, score, passCount, totalCount, assertions }`.
`score` is `passCount / totalCount` (0–1). Empty assertion list scores 1.

**`kodr eval --suite path`** in `app.mjs` loads the suite, builds workspace
context once (same as `kodr run`), runs `completeWithContinuations` + 
`extractProposal` per case, then calls `scoreCase`. Results land in
`eval-results.json` in the run artifacts dir.

**`evals/todo-cli.json`** is a new eval suite for the todo-cli example with
four assertions: `files_exist` (three core files), two `content_matches`
checks for `add` and `list` in the CLI, and `tests_pass`.

## Tricky fix: nested node --test

The `tests_pass` assertion runs `node --test` in a temp dir from inside
the `node --test` process that runs the eval tests. Node.js 24 added a
guard that detects recursive `node:test run()` usage and skips file
discovery entirely, making the inner process exit with code 0 even if
tests failed.

The fix is in `verification-runner.mjs`: `spawnCommand` now strips
`NODE_TEST_CONTEXT` and `NODE_CHANNEL_FD` from the child process
environment before spawning. These are the env vars that signal "you are
a test worker" to Node.js. Removing them lets the grandchild `node --test`
run standalone.

```
// Strip the Node.js test-runner's IPC vars so nested `node --test` runs
// don't trigger the "called recursively" short-circuit added in Node 24.
const env = { ...process.env };
delete env.NODE_TEST_CONTEXT;
delete env.NODE_CHANNEL_FD;
```

Without this fix, the test "fails when the generated tests contain a bug"
would always pass (because the inner test runner silently skipped the bug).

## Live test results

Two live eval runs against `qwen/qwen3.6-35b-a3b`.

**Run 1 — from koder-by-codex root (score 0/4):**

The model returned a 184-char response (empty proposal). It saw the
existing workspace files, determined the code was already present, and
returned `{ "status": "OK", "files": [], ... }`. The eval correctly
scored every assertion as failed — the model produced no files to check.

**Run 2 — from examples/todo-cli (score 0/4):**

The model returned 3462 chars but `extractProposal` threw `CliError:
Proposal messages must have string level and content`. The model generated
a messages array with `type`/`text` fields instead of `level`/`content`.
The eval correctly recorded this as a `completionError` and scored 0/4.

Both 0-score results are the eval working as designed. In run 1, the
workspace context caused the model to "cheat" (the files were already there).
In run 2, the model's message format deviated from the expected schema.
Both failure modes would require manual inspection without the eval —
now they surface automatically.

## Score interpretation

A score of 0 means the model produced no usable proposal for the
assertions to check. A score of 0.5 means half the assertions passed —
useful for tracking partial progress (e.g., files exist but tests don't
pass). A score of 1.0 means all assertions passed. The numeric score is
designed to be stable enough to trend over time across model versions or
prompt changes.

## What eval is not (yet)

The eval command uses the full workspace context (same as `kodr run`).
For code-generation eval cases, this has a side effect: if the workspace
already contains the target files, the model may return an empty proposal.
A future `--no-context` flag would pass a minimal system prompt, making
eval prompts workspace-independent.

The phase design mentioned wiring eval results into the comparison report.
The two artifacts (`comparison.json` and `eval-results.json`) are
currently separate but share the same run dir structure. The wiring — a
combined report with per-model scores — is left for phase 38 or later.
