# Phase 100: Brownfield Edit Eval Suite

## Goal

Make "can kodr edit an existing codebase" a number instead of an anecdote.
Every example so far is greenfield generation, and the one realistic trial
(postgres-docs-api) is exactly where the harness fell apart: repair turns
that proposed zero writes, a fix for `tests/utils.js` that created a
root-level `utils.js` sibling, tool budgets exhausted without converging.
This phase builds a committed suite of edit tasks against small fixture
repos, runs each task through the real `runPrompt` pipeline, scores the
resulting *workspace* (not the raw proposal), and records results in the
repo so models and harness changes can be compared over time. Phases
101–104 (edit formats, repair pressure, routing) all optimize against this
scoreboard.

## Motivation

- The existing eval path measures the wrong thing. The `eval` branch in
  `src/app.mjs` calls `completeWithContinuations` directly and hands the
  extracted proposal to `scoreCase` (`src/eval.mjs`) — it never enters
  `runPrompt`, so tool calls, inspection-aware context, apply, verification,
  and the heal loop are all invisible to it. Its `tests_pass` assertion
  writes the proposal's files into an *empty* temp dir; an edit task cannot
  even be expressed, because there is no pre-existing code for the model to
  edit or for the assertion to run against.
- The failure log already names the assertions this suite needs.
  `process/failures.jsonl` (phase 58 trial): Nemotron, told to fix
  `tests/utils.js`, created a root-level `utils.js` instead and the run
  read as progress — that is a `file_modified` + `files_absent` assertion.
  Repair runs "returned OK with zero file changes and scratchpad-only
  plans" — that is a workspace `tests_pass` assertion catching an applied
  no-op. Phase 78: `npm test` in a directory without `package.json` climbed
  to the repo root and passed against kodr's own tests — that is why every
  case runs in an isolated staged workspace with its own verification
  command.
- The pipeline seam already exists. `runPrompt(options, io)` resolves the
  workspace from `io.cwd`, and `createRunArtifacts(io.cwd, options.out)`
  accepts an output override — so the eval runner can stage a fixture into
  a temp dir, point `io.cwd` at it, redirect per-case run artifacts into
  the eval's own run dir, and get the full daily-driver pipeline (phase 97
  defaults: tools, streaming, auto inspection) plus apply, verification,
  and heal, with nothing mocked.
- Local model quality is improving fast (NEXT.md). The strategic value of
  a committed, re-runnable suite is that a new model landing in LM Studio
  gets a score the same day, against the same tasks, diffable against
  every previous run — the measurement infrastructure that phase 104's
  routing will consume.

## Design

### Suite schema: fixture cases alongside proposal cases

`loadEvalSuite` (`src/eval.mjs`) keeps the existing shape; a case gains an
optional `fixture` field naming a directory relative to the suite file
(e.g. `fixtures/js-fix-failing-test`). Its presence makes it a *workspace
case*; cases without it keep today's proposal semantics untouched.

Workspace cases add fields:

- `test` — the verification command run inside the staged workspace
  (passed through as the case's `testCommand`, validated by
  `parseVerificationCommand` like `--test` is today).
- `requires` — optional array of toolchain binaries (`python3`, `go`,
  `cargo`). Probed at run time the way `checkAvailability` in
  `src/external-inspector-registry.mjs` probes inspectors; a missing
  toolchain marks the case `skipped` with the reason, excluded from the
  score denominator — the suite stays runnable on machines without every
  toolchain.
- `expectFailingBaseline` — when true (the fix-a-bug shape), the runner
  executes `test` in the staged workspace *before* the model runs and
  requires it to fail. A baseline that unexpectedly passes is reported as
  `fixture-invalid`, not as a model pass — the guard against fixture
  drift silently inflating scores.
- `heal` — optional per-case override of the heal setting, so the suite
  can measure both first-attempt quality (`off`) and loop convergence
  (`auto`).

Assertions in workspace cases evaluate against the staged workspace on
disk after the run, not against the proposal object:

- `tests_pass` — runs `command` via `runVerification` in the staged
  workspace (existing type, workspace semantics).
- `content_matches` / `files_exist` — existing types, checked on disk.
- `file_modified` — new: the path exists and its content hash differs
  from the staged baseline. Directly encodes "edited the named file".
- `file_unchanged` — new: hash equals baseline; guards against collateral
  rewrites of files the task did not ask about.
- `files_absent` — new: named paths do not exist; encodes "did not create
  a sibling instead" (the `utils.js` failure, as an assertion).
- `content_absent` — new: a regex does not match a file; encodes "rename
  left no references to the old name".

Validation rejects workspace-only assertion types in proposal cases, and
`fixture` paths that do not resolve to a directory, with messages naming
the case id — same loud-schema posture as the rest of `loadEvalSuite`.

### Fixtures: measurement instruments, committed, never mutated

Fixture repos live under `evals/fixtures/<task-id>/`, small (≤ ~10 files
each), self-contained, with a `README.md` stating the task, the planted
defect, and why the assertions are what they are. They are deliberately
hand-authored: the AGENTS.md provenance rule exists so *examples* (kodr
outputs) test kodr's own behavior — fixtures are *inputs* with planted
bugs, the one thing kodr generation cannot produce on purpose. They live
in `evals/`, not `examples/`, and a decisions entry records the
distinction. Their intentionally failing tests must never leak into the
repo's own `npm test` (the `find test examples` discovery path does not
scan `evals/`; a regression test locks this).

The runner stages each case by copying the fixture into a fresh
`mkdtemp` workspace (skipping any `.kodr/`), recording baseline content
hashes for `file_modified`/`file_unchanged`, and never touches the
committed fixture — a mutation guard in tests compares the fixture dir
before and after a run. No `git init`, no network, no dependency
installs: every fixture runs on toolchain built-ins alone (`node --test`,
`python3 -m unittest`, `go test ./...`, `cargo test`), keeping cases
deterministic and fast to stage.

The initial suite, `evals/brownfield.json`, ships eight tasks across the
four repomap languages (`src/repomap/inspector.mjs` handles `.py`, `.rs`,
`.go` alongside JS/TS):

1. `js-fix-failing-test` — planted logic bug in a source file; fix the
   source, not the test (`file_unchanged` on the test file).
2. `js-fix-named-path` — the Nemotron reproduction: a broken helper at
   `tests/utils.js`, prompt names that path; `file_modified
   tests/utils.js`, `files_absent utils.js`.
3. `js-rename-function` — rename a function and its call sites across
   three files; `content_absent` old name, `tests_pass`.
4. `js-add-cli-flag` — add a flag to an existing CLI; a pre-written
   failing test describes the feature (the executable spec), so
   `tests_pass` is the primary assertion.
5. `ts-update-stale-test` — source behavior changed, test expectations
   are stale; update the test (`file_unchanged` on source). Runs via
   Node 24 type stripping, no `tsc`.
6. `py-fix-bug` — stdlib-only package with `unittest`; `requires:
   ["python3"]`.
7. `go-fix-bug` — single-module package with `go test`; `requires:
   ["go"]`.
8. `rust-fix-bug` — single-crate lib with `cargo test`; `requires:
   ["cargo"]`.

The mix covers the brownfield verbs — fix, rename, extend, update tests —
and the failure shapes the postgres trial actually produced.

### Execution: the real pipeline, per-case artifacts preserved

For each non-skipped workspace case the eval branch builds case options —
`yes: true` (apply without prompting; the phase 98 approver is never
injected here), `testCommand` from the case, heal per case/CLI, model per
case override or CLI — and calls `runPrompt(caseOptions, { ...io, cwd:
stagedDir })`. Per-case run dirs are redirected via `options.out` into
the eval run's own artifact tree (`<evalRunDir>/cases/<case-id>/`), so
the full forensic trail — requests, proposals, writes, verification,
repairs — survives the temp workspace's deletion. A `runPrompt` throw is
caught and recorded as the case's `runError`; assertions still execute
against whatever state the workspace reached, and the case fails rather
than aborting the suite.

Cases run sequentially — the target is a single local model server, and
serialized runs keep scores comparable. Each case is bounded by the
existing `--timeout` budget; `--cases id1,id2` filters the suite for
quick iteration while developing fixtures or harness changes.

### Scoring and recorded results

`scoreCase` keeps its shape (per-assertion ok, passCount, score). Each
workspace case result additionally records the diagnostics phases
101/102 will optimize: `applied`, repair count, stop/finish reasons,
`proposalFound`, duration, and skip/baseline status. Suite score is the
mean over non-skipped cases; skipped cases are listed with reasons, never
silently dropped (no silent caps).

`kodr eval --record` appends one line per completed suite run to
`evals/results/<suite-slug>/<model-slug>.jsonl` — the same append-only
jsonl convention as `process/*.jsonl`, which keeps history diffs to pure
line additions. Each line carries timestamp, kodr version, model, per-case
results, and the per-case prompt ids (phase 38), so a score is traceable
to the exact prompt revision it measured. Without `--record`, results go
only to the run dir's `eval-results.json` exactly as today. Comparing
models is comparing sibling files; comparing over time is reading one
file top to bottom. A single run is one sample from a nondeterministic
model — the file format deliberately invites multiple lines, and trends
matter more than any one line.

## What Does Not Change

- Proposal-mode eval suites: `evals/todo-cli.json` loads, runs, and
  scores byte-for-byte as today; the eval branch's existing
  proposal-only path remains the no-`fixture` route.
- `kodr eval` stays non-interactive and never prompts — workspace cases
  apply inside disposable staged dirs, never the user's cwd; the phase 98
  gate matrix ("eval injects nothing") still holds.
- `runPrompt` itself: the runner is a new caller, not a new pipeline. No
  new flags inside the run path, no eval-specific behavior in apply,
  verification, or heal.
- `npm test` discovery and `npm run check` coverage of `bin`, `src`,
  `test`, `test-support`, and `examples`; fixture code is exempt from
  repo-wide format/check (it is target material, including non-JS).
- The examples/ directory and its provenance rules — no new examples,
  per NEXT.md.

## Test Requirements

- Schema: a `fixture` case with workspace assertions validates; a
  workspace-only assertion type in a proposal case is rejected naming the
  case; a missing fixture directory is rejected naming the path;
  `requires` and `expectFailingBaseline` round-trip.
- Staging: fixture copied without `.kodr/`, baseline hashes captured;
  after a full case run the committed fixture directory is byte-identical
  (mutation guard).
- Full loop against `startFakeModelServer` (no real model in CI): a
  scripted proposal that fixes the planted bug in the right file →
  `tests_pass`, `file_modified`, `files_absent` all pass; a scripted
  proposal that writes a root-level sibling instead → `file_modified`
  and `files_absent` fail — the `utils.js` failure encoded as a fixture
  test; a scripted zero-write OK envelope → workspace `tests_pass` fails
  (no-progress turns cannot score as passes).
- Baseline guard: a fixture whose `expectFailingBaseline` test already
  passes reports `fixture-invalid`, not a pass.
- Skip gating: a case requiring a nonexistent binary is `skipped` with a
  reason, excluded from the denominator, present in output and results.
- Artifacts: per-case run dirs land under the eval run dir via
  `options.out`; a case `runError` is recorded and the suite continues.
- Recording: `--record` appends exactly one well-formed line to the
  expected path; without `--record` nothing under `evals/results/`
  changes.
- Suite hygiene: a test asserts the repo's own test discovery matches no
  files under `evals/fixtures/`.
- New assertion types: unit tests for `file_modified`, `file_unchanged`,
  `files_absent`, `content_absent` against staged directories, including
  the unchanged-hash and missing-file edges.

## Non-Goals

- No cloned open-source repos or git submodules — committed fixtures
  only. Real-repo trials remain manual experiments (the postgres trial
  pattern); determinism and offline runs win here.
- No exact-file-match scoring: models legitimately vary; behavior
  (`tests_pass`) plus file-shape assertions are the contract.
- No harness changes that *use* the scores — edit-format selection
  (101), no-progress escalation (102), and model routing / `kodr bench`
  (104) consume this suite; they do not ship in it.
- No parallel case execution, no LLM-as-judge scoring, no flakiness
  retries — one case, one run, one line of results.
- No dependency-installing fixtures (npm/pip/cargo registries) in this
  pass; toolchain built-ins only.

## Done Criteria

- [x] Schema and loader extensions: `fixture`, `test`, `requires`,
      `expectFailingBaseline`, `heal`, and the four new assertion types,
      validated loudly.
- [x] Workspace case execution through `runPrompt` with staged temp
      workspaces, baseline hashing, redirected per-case artifacts, and
      sequential runs.
- [x] Toolchain probing with recorded skips; baseline guard reporting
      `fixture-invalid`.
- [x] Eight fixtures committed under `evals/fixtures/` with per-fixture
      READMEs documenting task, planted defect, and assertions;
      `evals/brownfield.json` wires them up.
- [ ] `--record` appending to `evals/results/<suite>/<model>.jsonl`; one
      real recorded run against the default local model committed as the
      first baseline.
- [x] Tests per Test Requirements.
- [x] evals.md and usage.md document workspace cases, new assertions,
      skips, and recording; decisions entry for the fixture-provenance
      distinction.
- [x] Record decisions and any failures.
- [x] Blog post.
- [x] Mark roadmap complete and commit.
