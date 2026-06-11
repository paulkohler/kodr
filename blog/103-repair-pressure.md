# Phase 103: Making the Healing Loop Push Back

The healing loop exists so Kodr can fix its own mistakes without asking the
user. But the loop had a passivity problem: when the model stalled or targeted
the wrong file, the loop either stopped immediately or silently continued with
the same prompt. Neither response pressures the model to do better. Phase 103
adds three concrete pressure mechanisms.

## The Stall Problem

A zero-change turn means one of two things: the model genuinely cannot figure
out what to write, or it is spinning on reasoning without committing to a
proposal. The old behavior was to count two consecutive zero-change turns and
stop with `'no_progress'`. The loop gave up on the first real stall.

The new behavior distinguishes between "first stall" and "second stall."

On the first zero-change turn, `noProgressCount` reaches 1 and the next prompt
is an escalation. `renderEscalationPrompt` builds a harder message: it restates
that no changes were made, quotes the current test failures verbatim, includes
the scratchpad the model already wrote, and demands a concrete proposal. It
does not give the model credit for its reasoning — it tells the model the
reasoning was not enough.

Only on the second consecutive zero-change turn does the loop stop, now with
`'no-progress-exhausted'`. The distinction matters for diagnostics: a run that
exhausted no-progress attempts is a harder failure than one that simply ran out
of turns.

## The Wrong-File Problem

`touchesFailurePath` checks whether any proposed write touches the file
mentioned in the test output. A model that writes to `src/other.mjs` when the
failure is in `src/foo.mjs` is not making progress — but the old loop stopped
immediately on any wrong-path write.

The new behavior is to warn first. On the first wrong-path turn, the loop
records `wrongPathSiblings` (what was written vs. what was expected), increments
`wrongPathWarnings`, and injects a clear warning section into the next prompt:
"You wrote to [src/other.mjs] but the failure is in [src/foo.mjs]. Fix the
correct file." The loop then continues.

Only on the second consecutive wrong-path write does the loop stop with
`'wrong_path_exhausted'`. The final healing result carries `wrongPathWarnings`
so callers can see whether a warn was issued before the eventual stop.

This mirrors how a human reviewer would respond: the first wrong guess gets a
correction, the second gets a stop.

## Verification Delta Tracking

The third mechanism is quieter. After each repair turn that re-runs
verification, `computeTestDelta` compares the failure count before and after
the repair. If the count did not decrease, the next prompt notes it: "Tests
still failing with same count (N failures). The previous repair did not address
the root cause."

`extractFailCount` counts lines matching common failure patterns: `not ok`,
`FAIL`/`FAILED`/`FAILURE`, `✗`, and numeric failing counts. It runs across both
stdout and stderr. The delta is written to `turn-N/test-delta.json` and
attached to the repair turn artifact so run artifacts show whether each repair
attempt made measurable progress.

## Implementation Notes

The three mechanisms are additive and independent: a turn can trigger
no-progress escalation, or a wrong-path warning, or a stale-count note in the
delta section — they do not interact. The stop-reason rename (`'no_progress'`
→ `'no-progress-exhausted'`, `'wrong_path'` → `'wrong_path_exhausted'`) is a
deliberate breaking change on the artifact field. Anything consuming
`stopReason` should handle the new values; the old values are gone.

The `noProgressCount` counter resets when the model makes actual changes,
and `wrongPathCount` resets when the model touches the right file. The pressure
mechanisms are per-streak, not per-run total — a model that recovers after one
stall gets a fresh slate.

## What This Enables

The immediate payoff is that weak local models get a second chance with a
stronger prompt before the loop gives up. The longer payoff is that
`wrongPathWarnings` and the per-turn test delta artifacts give Phase 106 (Run
Forensics) structured evidence of exactly where in the healing loop a model
started to fail: stalled, targeted the wrong file, or kept failing the same
tests despite writing changes.
