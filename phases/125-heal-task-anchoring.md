# Phase 125 — Heal Task Anchoring (anti goal-substitution)

## Motivation

The heal loop's worst failure mode is a false success: a run reports `healed`
while the requested artifact was never produced. The phase-113 greenfield
logstats run is the canonical case — extraction produced zero files, the heal
loop received a repair prompt with no memory of the original task, and it
"healed" by inventing a trivial unrelated module with its own passing test.
Verification went green on the invented test, so the harness reported success.

Two structural weaknesses enable this:

1. **The repair prompt has no anchor to the original task.** `renderLoopRepairPrompt`
   carries "the previous verification failed", the tests JSON, and the failing
   files — but never *what was actually asked*. A model with no goal can drift
   into solving a different, simpler problem.
2. **A zero-write run can enter the heal loop and invent success.** When the
   original turn generated nothing and verification ran no tests, the model
   failed to *generate*, not to *pass* — but the loop happily lets it create
   brand-new files whose own tests pass, and `verification.ok` (ground truth)
   then reports `healed`.

This phase closes both, centrally (all three heal call sites funnel through
`runHealingIfNeeded` → `runSelfHealingLoop`).

Evidence: `~/src/kodr-testing/phase-113/greenfield-logstats-1/`;
`process/failures.jsonl` phase 113-dogfood; `src/healing.mjs`
(`renderLoopRepairPrompt`/`renderEscalationPrompt`/`buildRepairContext`).

## Design principles

1. **Anchor every repair to the task.** The original user request rides in the
   repair context and is rendered in both the loop and escalation prompts.
2. **Don't convert "produced nothing" into "healed".** A zero-write run whose
   verification ran no tests is reported honestly (`stopReason: nothing-generated`,
   `ok: false`), never entered into the repair loop.
3. **Precise guard, no brownfield regression.** The guard fires only on
   `writeCount === 0` AND a verification that ran zero tests. A real failing
   suite (tests > 0) with zero writes is still a legitimate repair situation and
   still heals.
4. **Central, not per-site.** One change in `runHealingIfNeeded`/`healing.mjs`
   covers the standard, staged, and subagent heal paths.

## Work items

### C1 — Task anchor in repair prompts

`runHealingIfNeeded` passes `originalTask: options.prompt` into
`runSelfHealingLoop`. `buildRepairContext` stores `originalTask`;
`renderLoopRepairPrompt` and `renderEscalationPrompt` render an
`## Original task` section ("The repair must serve this original request — do
not solve a different or simpler problem: …") when present, and nothing when
absent (byte-stable for existing no-task callers).

### C2 — Nothing-generated guard

`isNothingGenerated(writeCount, testResult)` (in `healing.mjs`) is true when
`writeCount === 0` and `hasNoTestsRun(testResult)` (TAP `tests 0` / "no test
files found"). `runHealingIfNeeded` gains a `writeCount` argument (passed at all
three call sites from the run's write count) and, when the guard fires, returns
`{ healed: false, skipped: true, stopReason: 'nothing-generated',
finalVerification: testResult }` without entering the loop. The run's `ok`
stays false; `summary.healStopReason` records the honest reason.

## Testing

- C1: `buildRepairContext` carries `originalTask`; `renderEscalationPrompt` and
  the live loop prompt include `## Original task` with the task text; absent when
  no task.
- C2: `hasNoTestsRun` and `isNothingGenerated` truth tables (zero-test vs real
  failing suite vs writes-present vs unknown writeCount).
- Regression: full suite green; existing heal tests unchanged.

## Result

All unit tests pass, including a loop test that drives `runSelfHealingLoop` with
real `node --check` verification and asserts the repair prompt carries the task.
Fixing the `writeCount` wiring surfaced and fixed a latent TDZ bug in the staged
path (`writeResult` is block-scoped per stage; the aggregate is `allWrites`) —
that path would have thrown at runtime when healing a staged run.

Live: a planted-bug heal run against gpt-oss-20b fixed the bug on the first
attempt (no repair turn), confirming no regression in the normal path. Forcing a
real model to need a repair turn is nondeterministic; the anchoring is proven by
the real-verification loop test instead.

## Done criteria

- [x] C1: original task threaded into repair context + both repair prompts.
- [x] C2: `isNothingGenerated` guard in `runHealingIfNeeded`; `writeCount` wired
      at all three heal call sites; honest `nothing-generated` stop reason.
- [x] Latent staged-path `writeResult` TDZ bug fixed.
- [x] Unit tests for C1 and C2; full suite green.
- [x] `process/decisions.jsonl` + `process/failures.jsonl` updated.
- [x] Blog post `blog/125-heal-task-anchoring.md`.
- [x] NEXT.md revised; version bumped to 0.0.125; committed.
