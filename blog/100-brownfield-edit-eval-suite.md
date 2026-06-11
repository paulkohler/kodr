# Phase 100: Brownfield Edit Eval Suite

Phase 100 makes "can kodr edit an existing codebase" a number instead of an
anecdote. Until now every measured eval was greenfield generation — the model
starts with an empty directory and the harness checks what it created. Edit
tasks were only tested manually, and the manual record (`process/failures.jsonl`)
contained exactly the failures this phase was designed to catch.

## What shipped

**Eight fixture repositories** under `evals/fixtures/`, each a small broken
codebase with one planted defect:

| ID | Language | Defect |
|---|---|---|
| `js-fix-failing-test` | JS | `add` returns `a + b + 1` |
| `js-fix-named-path` | JS | `trimName` uppercases instead of trims |
| `js-rename-function` | JS | `processItem` must become `transformItem` everywhere |
| `js-add-cli-flag` | JS | `--version` flag missing from `parseArgs` |
| `ts-update-stale-test` | TypeScript | test expects lowercase; source now returns uppercase |
| `py-fix-bug` | Python | `multiply` returns `a + b` |
| `go-fix-bug` | Go | `Add` returns `a - b` |
| `rust-fix-bug` | Rust | `multiply` returns `a + b` |

Every fixture has a test file that **fails before the fix** and would pass after a
correct edit. `expectFailingBaseline: true` makes the harness verify this
invariant — if a fixture's test ever starts passing unexpectedly, it's flagged
`fixture-invalid` before any model turn runs.

**New assertion types** for workspace state post-run:

- `file_modified` / `file_unchanged` — SHA-256 baseline hashing confirms which
  files changed
- `files_absent` — guards against the Nemotron failure pattern (creating
  `utils.mjs` at the root instead of editing `tests/utils.mjs`)
- `content_absent` — confirms old identifiers were renamed away

**Full pipeline execution** via `runPrompt`. Previous eval cases called
`completeWithContinuations` directly, bypassing tools, apply, verification, and
heal. Workspace cases call the real pipeline so toolchain verification, the heal
loop, and the patch/file apply all run. The harness scores the workspace on disk,
not the raw proposal object.

**Toolchain probing** via `requires`. Cases listing `['python3']`, `['go']`, or
`['cargo']` are automatically skipped on machines without those binaries, with a
recorded reason and exclusion from the score denominator.

**`--record` flag** appends a timestamped JSONL entry to
`evals/results/<suite-slug>/<model-slug>.jsonl`. The file is append-only so every
run against the same model accumulates a comparison history.

## Failures and fixes

### Circular import

`eval-runner.mjs` needed to call `runPrompt` from `app.mjs`, but `app.mjs`
already imported `eval-runner.mjs`. Node.js ESM raises a ReferenceError on
circular bindings that haven't been initialized. Resolved by dependency injection:
`runPrompt` is passed as `options._runPrompt` at the eval command call site.
`eval-runner.mjs` never imports `app.mjs`.

### Streaming with fake model server

The most subtle failure: `stream: 'auto'` is truthy, so `createChatCompletion`
routed to `requestStreamJson`. The fake model server returns plain JSON (not SSE),
so `readServerSentEvents` parsed nothing and `firstAssistantMessage` returned an
empty string. `completeWithToolCalls` then returned an empty `completion.text`,
`extractProposal` returned null, and no files were written — the model "ran" but
left every `file_modified` assertion failing.

The `main()` function resolves `'auto'` via `io.stdout.isTTY === true` before
calling into the pipeline, but `runWorkspaceCase` calls `runPrompt` directly and
bypasses `main()`. The fix adds `stream: options.stream === 'auto' ? false : options.stream`
to `caseOptions` in `eval-runner.mjs` — matching `main()`'s resolution for a
non-TTY context.

Diagnosed by tracing the fake server request body: expected `stream: true` for a
streaming request, but received `stream: undefined` in the working eval test and
`stream: true` in the broken workspace test path.

### `\d{2}` regex in `roadmapVersion`

The cversion check failed with "0.0.98 does not match roadmap version 0.0.99"
because phase 99 was already marked done but `package.json` hadn't been bumped.
Fixing it revealed a second bug: after marking phase 100 done, `roadmapVersion`
still returned `0.0.99` because its regex matched exactly two digits (`\d{2}`),
silently skipping `100`. Fixed to `\d+`.

## Test coverage

43 new tests in `test/eval-runner.test.mjs` covering:

- Schema validation: workspace fields, round-trip of `requires`/`expectFailingBaseline`,
  rejection of workspace-only assertion types in proposal cases
- Fixture staging: `.kodr/` skipped, baseline hashes captured, original unchanged
- Assertion unit tests: all four new types with pass/fail/edge cases
- Full loop via `startFakeModelServer`: correct fix passes, wrong-path fix fails
  `file_modified`+`files_absent`, zero-write envelope fails `tests_pass`
- `fixture-invalid` and `skipped` statuses
- `recordResults`: append-only JSONL, two-run accumulation
- Artifact directories: per-case `cases/<id>` dir created under eval run dir
- `runError` recorded, suite continues
- `--record` integration: appends; absent keeps `evals/results/` empty
- Suite hygiene: test discovery doesn't reach `evals/fixtures/`
