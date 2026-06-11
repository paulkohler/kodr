# Phase 98: Interactive Apply Prompt

## Goal

Stop paying the model cost twice. Today a CLI dry-run that proposes writes
ends with "re-run with `--yes`", which means a second multi-minute local
inference for the same task — and a second proposal that may not even match
the one the user just reviewed. The TUI already solved this with the pending
review and `/accept`; the CLI one-shot should get the same one-pass flow:
propose, show, ask `apply? [y/N]`, apply — without calling the model again.

## Motivation

- The two-pass flow is hardcoded at the apply gate. `parseArgs`
  (`src/app.mjs`) defaults `dryRun: true, yes: false`; `--yes` flips both.
  Inside `runPrompt` the proposal reaches
  `prepareChanges(io.cwd, proposal, { apply: options.yes, ... })`, and a
  dry-run summary ends with the literal line
  `Re-run with --yes to apply these changes.` (`renderRunSummary`, gated on
  `!result.applied && writeResult.writes.length > 0`). The re-run is a full
  new inference against the default local model — the reviewed proposal is
  discarded, and the `--yes` run may propose something different.
- The TUI shows the target shape. `isPendingReview` (`src/tui.mjs`) uses the
  same unapplied-writes predicate to store a pending review, and `/accept`
  sends `{ kind: 'apply-proposal', proposal, runDir, sessionId }` through
  the shared channel — the model is not called again. Phases 96–97 just made
  the bare CLI one-shot the daily driver (config defaults, tools/stream on);
  the dry-run dead end is the friction that remains.
- The approval contract already exists. Phase 67 established
  `createPermissionRequest(action, input, reason)` (`src/tools.mjs`) and the
  approver shape `{ decision: 'allow' | 'deny', reason }` that
  `ToolRunner.checkPermission` consumes via an injected
  `options.permissionApprover`; `handleChannelRequest` answers
  `permission-request` with deny ("No interactive permission approver is
  available") when no surface can ask. The CLI prompt should reuse that
  request/decision shape, not invent a parallel one.
- There is an adjacent artifact bug worth fixing in the same pass: the
  `apply-proposal` channel handler (`handleChannelRequest`, `src/app.mjs`)
  applies writes but never updates the run directory's `writes.json`, and
  `undoLastApply` → `findLastAppliedRun` (`src/undo.mjs`) discovers applied
  runs by reading exactly that file — so a TUI `/accept` apply is invisible
  to `/undo` today. Phase 98's invariant — every apply decision is recorded
  in run artifacts — should hold for both surfaces.

## Design

### Decision point: inside `runPrompt`, at the existing apply gate

- The prompt resolves where `apply` is decided today, not after the run
  returns. When `options.yes` is false, explicit `--dry-run` was not passed,
  and an apply approver is injected: run `prepareChanges` in dry-run mode to
  get the real write list (entries carry
  `{ status: 'create' | 'modify', path, diff, hash }` from
  `prepareWrites` / `preparePatches` in `src/safe-writes.mjs`), build a
  `createPermissionRequest('apply-writes', ...)` carrying that list and the
  proposal messages, await the approver, and on allow call `prepareChanges`
  again with `apply: true`. Nothing touches disk between the two calls.
- The resolved decision — `'flag'` (`--yes`), `'prompt-accepted'`,
  `'prompt-declined'`, or `'none'` (no approver / explicit dry-run) — feeds
  the downstream gates that currently read `options.yes`: dependency install
  (`installDependencies && yes`), verification (`testCommand && yes`), heal
  (`runHealingIfNeeded` early-returns on `!options.yes`), each consuming the
  resolved value instead of the raw flag. An accepted prompt therefore runs
  the exact `--yes` pipeline — install, test, bounded heal — with no new
  execution path, and `summary.json` / `writes.json` are written after the
  decision, so artifacts record it for free. `summary.applyDecision` carries
  the provenance alongside the existing `applyRequested`.
- Why not the TUI's after-the-run `apply-proposal` request: healing needs
  `model`, `registry`, and `systemPrompt`, which exist only inside
  `runPrompt`'s scope — an apply that happens after `runPrompt` returns
  cannot run the heal loop without rebuilding the model client and context;
  and the late apply would hit the same stale-`writes.json` problem the TUI
  has. Deciding before artifacts are written avoids both. The shared pieces
  remain shared: the phase 67 request/decision shape, `prepareChanges`, and
  the install/verify/heal/commit pipeline.

### Surface wiring: the CLI injects, everything else stays dry-run

- `runCli`'s run branch injects the approver the same place it wires the
  `onStreamContent` chunk renderer and `withCliProgress`, and only when
  `io.stdin.isTTY && io.stdout.isTTY && !options.json && !options.yes` and
  `--dry-run` was not explicit. The approver renders per-file
  `status path` lines plus proposal messages — the same shape as the TUI's
  `renderPendingReview` — then asks `apply? [y/N]` with
  `node:readline/promises` (precedent: `runTui`). Full diffs stay in the run
  dir; the prompt shows the file list, not the patches.
- Only `y` / `yes` (case-insensitive) accepts. Empty line, EOF, or any other
  input declines. No timer: decline is the default, an unanswered prompt
  holds no writes, and the `resolveReviewTimeoutMs` precedent caps waits on
  models, not on humans.
- `--dry-run` gains a `_dryRunSet` sentinel following the existing `_*Set`
  pattern — today the flag just re-sets the default and is indistinguishable
  from it. Explicit `--dry-run` is the new behavior's off switch, per the
  phase 97 rule that every new default ships one.
- The approver answers only `action === 'apply-writes'`. It is not wired
  into `ToolRunner`'s `options.permissionApprover`, so mid-run tool
  permission requests in a one-shot CLI run keep failing safe exactly as
  today.
- TUI, `kodr serve`, openshell-worker, and the workflow/cycle/compare/eval
  branches inject nothing: the TUI keeps pending review + `/accept`, HTTP
  turns stay dry-run, and `handleChannelRequest`'s deny-by-default
  `permission-request` answer remains the non-interactive truth.

### Shared-machinery repair

- The `apply-proposal` channel handler updates the originating run
  directory's `writes.json` (and the summary's applied/decision fields)
  after a successful late apply, so TUI `/accept` applies become visible to
  `/undo` and replay — the same invariant the CLI prompt path gets natively.

### Output

- Accepted runs render through the existing `applied` branch of
  `renderRunSummary`, followed by the existing Tests/Repairs/Install lines;
  the re-run hint disappears because the writes are applied.
- Declined runs keep the dry-run rendering and the `Re-run with --yes` hint,
  with the proposal-mode line stating the decline so the artifact trail and
  the terminal agree.

## What Does Not Change

- Dry-run stays the default for every non-interactive surface: non-TTY
  stdin/stdout, `--json`, `kodr serve` (loopback, dry-run), openshell
  worker, workflow and cycle runs, `compare` and `eval`.
- `--yes` semantics, and `--commit requires --yes` at parse time — an
  interactive accept does not unlock git commit.
- Staged execution (`runStagedPrompt` applies per stage at its own
  `prepareChanges` call) and `--subagent-stages` orchestration keep their
  current `--yes`-gated behavior; per-stage prompting is a different UX and
  is deferred.
- The permission policy, tool registry, sandbox flags, and skill command
  approval. No prompt for non-write effects.
- The TUI flow: pending review, `/accept`, `/reject`, `/allow`, `/deny`.

## Test Requirements

- Accept path: a fake-model run (`startFakeModelServer`) proposing a write,
  with TTY-shaped io and scripted stdin answering `y`, applies the file,
  records `applied: true` and `applyDecision: 'prompt-accepted'` in
  `summary.json` and `writes.json`, and makes exactly one model request.
- Decline paths: `n`, empty line, and EOF each leave the workspace
  untouched, record `prompt-declined`, and keep the re-run hint; the run's
  `ok` semantics match today's dry-run.
- Gate matrix: non-TTY stdin, non-TTY stdout, `--json`, `--yes`, and
  explicit `--dry-run` never prompt; `--yes` applies with
  `applyDecision: 'flag'`; no-approver runs record `'none'`.
- Post-accept pipeline: with `--test`, verification runs after an accepted
  prompt (`tests.json` written); with a failing test and heal `auto`, the
  bounded repair loop runs (`repairs/` artifacts) — proving the heal gate
  consumes the resolved decision, not the raw `--yes` flag.
- Undo: a prompt-accepted run is found by `undoLastApply`; a TUI `/accept`
  apply is now also found, via the `apply-proposal` artifact update.
- Channel contract: the approver request carries `action: 'apply-writes'`
  and the phase 67 shape; `permission-request` without an approver still
  denies; a `kodr serve` turn never prompts.

## Non-Goals

- No per-file selective apply in the first pass (accept or decline the
  whole proposal).
- No prompt for non-write effects — install, commands, and network stay on
  the permission policy and their existing flags.
- No mid-run tool permission prompting in the one-shot CLI (the phase 67
  TUI flow keeps that).
- No prompt timeout, persistent trust store, or "always allow" memory.
- No staged or subagent-stages prompting.

## Done Criteria

- [x] Interactive dry-run proposals prompt once at the `runPrompt` apply
      gate and apply without a second model call.
- [x] The prompt uses the phase 67 permission request/decision shape, with
      the approver injected only by the CLI run branch.
- [x] Decline, EOF, non-TTY, `--json`, explicit `--dry-run`, and `--yes`
      paths all behave per the gate matrix, with `_dryRunSet` added.
- [x] `summary.applyDecision` recorded for accepted, declined, flag, and
      none cases; declined proposals visible in run artifacts.
- [x] Install, verification, and heal run after an accepted apply exactly
      as under `--yes`.
- [x] `apply-proposal` updates run artifacts so TUI `/accept` applies are
      visible to `/undo`.
- [x] Tests per Test Requirements.
- [x] usage.md and help text document the prompt and its off switches.
- [x] Record decisions and any failures.
- [x] Blog post.
- [x] Mark roadmap complete and commit.
