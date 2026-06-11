# Phase 103: Repair Pressure And No-Progress Detection

## Goal

Make the healing loop harder to fool. Three enhancements that turn passive
retries into active pressure on the model when it stalls or targets the wrong
file.

## Changes

### 1. No-Progress Escalation (`src/healing.mjs`)

**Before:** two consecutive zero-change turns → stop with `'no_progress'`.

**After:**
- Turn produces zero writes → increment `noProgressCount`
- `noProgressCount === 1`: send an **escalation prompt** that restates the
  unmet goal and quotes the scratchpad. Loop continues.
- `noProgressCount >= 2`: stop with `'no-progress-exhausted'`.

New exports: `renderEscalationPrompt(repairContext, { index, maxTurns })`.

### 2. Path-Aware Repair Validation (`src/healing.mjs`)

**Before:** `touchesFailurePath()` false → stop with `'wrong_path'` immediately.

**After:**
- First wrong-path turn: record `wrongPathSiblings`, increment
  `wrongPathWarnings`, send next prompt with a "you wrote to X but failure is
  in Y" section. Loop continues.
- Second wrong-path turn: stop with `'wrong_path_exhausted'`.
- Final result includes `wrongPathWarnings` count.

New exports: `renderWrongPathWarning(writes, failurePaths)`.

### 3. Verification-Delta Tracking (`src/healing.mjs`)

Each repair turn that re-runs verification computes a `testDelta` artifact
comparing failure counts before and after. When the count does not decrease,
the next prompt includes: "Tests still failing with same count (N failures).
The previous repair did not address the root cause."

New exports: `extractFailCount(testResult)`, `computeTestDelta(prev, curr)`.

Delta artifacts written to `turn-N/test-delta.json`.

### Renamed stop reasons

| Old | New |
|-----|-----|
| `'no_progress'` | `'no-progress-exhausted'` |
| `'wrong_path'` | `'wrong_path_exhausted'` (second occurrence) |

The first occurrence of each is now a warn-and-continue, not a stop.

## Done criteria

- [x] `extractFailCount` counts failure lines from test stdout/stderr
- [x] `computeTestDelta` returns `{before, after, improved}`
- [x] `renderEscalationPrompt` builds stronger re-prompt for no-progress turns
- [x] `renderWrongPathWarning` returns path-mismatch warning text
- [x] No-progress: escalate on count=1, stop `'no-progress-exhausted'` on count=2
- [x] Wrong-path: warn on count=1, stop `'wrong_path_exhausted'` on count=2
- [x] `wrongPathWarnings` recorded in final healing result
- [x] `testDelta` recorded per turn artifact and in repair push
- [x] `renderLoopRepairPrompt` accepts `wrongPathWarning` and `testDelta` opts
- [x] All new helpers exported and tested
- [x] Integration tests: escalation flow, wrong-path warn-then-stop
- [x] Existing no-progress and wrong-path tests updated to new stop reasons
- [x] `package.json` version bumped to match roadmap (0.0.102)
- [x] All 23 healing tests pass
- [x] `npm run check` clean
