# Phase 157: Run the Deterministic Gates in Subagent-Stages Mode

## Motivation

A comparison re-run of the phase-155 stress tests (driven by the test-operator against the
local qwen model) surfaced that the phase-156 smoke-check **never fired** on the Express
build: `summary.smokeCheck` was *absent*, not failed. Re-derived from the code (not the
operator's claim), the cause is structural:

- `runPrompt` (`src/run-pipeline.mjs`) has two paths. When `--subagent-stages` is set it
  branches early (≈line 471) into `runSubagentStages`, builds its **own** summary and
  `runOk`, and returns — it never reaches the syntax gate (`runSyntaxGateIfNeeded`, ≈1416)
  or the smoke-check (`runSmokeCheckIfNeeded`, ≈1459) that live in the default path below.
- Orchestration's own verification (`runOrchestrationVerification`, `orchestration.mjs`)
  runs **only the test command**, and only when `--test` is set. With `--no-test` (every
  stress test) the sole gate is the advisory model-reviewer.

So in `--subagent-stages` mode — the mode used for all multi-file work and all the stress
tests — **both** the phase-156 smoke-check **and** the phase-121 syntax gate are silently
absent. Phase 156's headline feature is dead exactly where it would matter, and the syntax
gate has been missing from orchestrated runs since orchestration shipped.

(This round qwen happened to write the JWT import correctly — `import jwt from
"jsonwebtoken"` — so the app booted and there was no crash to catch. The gap is that
*whenever* the model regresses, nothing deterministic would catch it.)

## What this phase does

Wire the two deterministic gates into the subagent-stages branch, mirroring the default
path:

- Run `runSyntaxGateIfNeeded` on the orchestration writeResult **before** the existing
  heal loop, and (parity with the default path) synthesise a verification-shaped result
  on syntax failure so `--heal` can repair it.
- Run `runSmokeCheckIfNeeded` **after** the heal merge (probe the final tree), host-only
  and skipped under an active sandbox executor — same conditions as the default path.
- Fold both into `runOk`: a syntax failure or a definitive smoke failure makes the run
  not-ok (unless a test command passed). Record `summary.syntaxCheck` / `summary.smokeCheck`.

To avoid drift between the two paths, extract the ok-folding decision into a shared,
unit-tested `deterministicGateOutcome({ syntaxResult, smokeResult, testResult })` helper
and use it in both branches.

## Scope notes

- Smoke still needs deps on disk to link bare specifiers; `--install` (or a pre-installed
  workspace) is what makes it meaningful, otherwise it reports `skipped` (advisory). That
  is unchanged — this phase only fixes *where* the gate runs, not when it is conclusive.
- Feeding a failed *smoke* into the heal loop remains a follow-up (already in NEXT); this
  phase feeds only *syntax* into heal, matching the default path.

## Done criteria

- [x] `deterministicGateOutcome` helper exported from `run-pipeline.mjs`; default path
      uses it (behaviour-identical).
- [x] Subagent-stages branch runs the syntax gate (feeds heal) and smoke-check (post-heal,
      host-only, sandbox-skipped), folds both into `runOk`, records both in the summary.
- [x] Unit test for `deterministicGateOutcome` (syntax-fail, smoke-fail, smoke-skipped/
      timeout no-op, test-passed override).
- [x] Live integration run: `~/src/kodr-testing/phase-157/wiring-check/` — a
      `--subagent-stages --yes` qwen build (planner → 2 isolated authors → reviewer)
      produced `summary.syntaxCheck {checked:1, ok:true}` and
      `summary.smokeCheck {entry:"index.mjs", source:"start", status:"ok", durationMs:178}`.
      Before this phase both were absent in subagent mode. Wiring proven on a real
      orchestrated local-model run.
- [x] `npm run format`, full suite green (1508), `npm run check` green; decisions/failures
      logged; blog post; roadmap checked; version 0.0.157; committed.
