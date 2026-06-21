# Phase 242: Surface Staged-Runaway and Heal-Overflow Events in CLI Output

## Motivation

Phases 240 and 241 added diagnostic metadata to `summary.json`:
- `staged.runawayRetries` — count of staged implement turns that hit `finish_reason=length`
  + zero content and were retried (phase 240)
- `healContextOverflowRetries` — count of repair turns that hit HTTP-400 "Context size
  exceeded" and were retried (phase 241)
- `repair_context_overflow` — a new heal stop reason when both the first call and the
  retry 400 (phase 241)

None of these events are surfaced in the terminal output from `kodr run`. The user sees
`Run failed` with no explanation. The forensics are buried in `summary.json`.

`run-summary.mjs` already has targeted messages for `reasoning_runaway` and `timeout`
stop reasons (lines 112–141). This phase extends it to cover the two new events.

## What to add to `renderRunSummary`

### 1. `repair_context_overflow` stop reason (like `reasoning_runaway`)

In the `if (result.healingResult)` block (line ~109), add a branch after the
`reasoning_runaway` branch:

```js
} else if (hr.stopReason === 'repair_context_overflow') {
    lines.push(
        'Repairs: not healed (repair_context_overflow) — the repair request returned HTTP 400 ' +
        '"Context size exceeded". LM Studio\'s KV-cache from the main loop may have carried ' +
        'over; a retry was attempted. Retry the run or restart LM Studio if this persists.',
    );
}
```

### 2. `healContextOverflowRetries > 0` annotation (within existing heal result block)

When healing DID succeed or is in progress, but a context-overflow retry was needed,
add a note to the existing repair line. Append after the main repair line:

```js
if (hr.healContextOverflowRetries > 0) {
    lines.push(
        `  (note: ${hr.healContextOverflowRetries} repair turn(s) hit HTTP-400 context overflow ` +
        `and were retried — LM Studio KV-cache bleed from main loop)`,
    );
}
```

### 3. `staged.runawayRetries > 0` annotation in staged run output

When the run used the staged pipeline and `result.staged?.runawayRetries > 0`, add a
note after the staged pipeline section:

```js
if (result.staged?.runawayRetries > 0) {
    lines.push(
        `  (note: ${result.staged.runawayRetries} staged implement turn(s) hit reasoning ` +
        `runaway and were retried with a capped max_tokens — see summary.json for evidence)`,
    );
}
```

Look for where `result.staged` is currently rendered (search for `staged` in
`run-summary.mjs`) and append after that block. If there's no explicit `staged`
rendering yet, find the natural place (after `testResult` or after `proposal`).

## Where to insert in `renderRunSummary`

Read `src/run-summary.mjs` top-to-bottom to understand the flow before inserting.
The file is about 250 lines. The ordered rendering is roughly:
1. Run ok/fail + stopReason
2. Model
3. Usage
4. Proposal (writes, scratchpad, messages, errors)
5. Tests
6. Healing result
7. Install result
8. Unapplied-writes note
9. Run dir
10. Tokens

The `repair_context_overflow` message goes in the healing result block (step 6).
The `staged.runawayRetries` note can go after the proposal block or after usage.
Look for any existing `staged` reference in the file to find the best insertion point.

## Tests

Add to `test/app.test.mjs` or a dedicated `test/run-summary.test.mjs`:

**Test A**: `renderRunSummary` with `healingResult.stopReason === 'repair_context_overflow'`
includes the expected phrase "repair_context_overflow" and "HTTP 400".

**Test B**: `renderRunSummary` with `healingResult.stopReason === 'healed'` and
`healingResult.healContextOverflowRetries === 2` includes "2 repair turn(s) hit HTTP-400".

**Test C**: `renderRunSummary` with `staged.runawayRetries === 1` includes
"1 staged implement turn(s) hit reasoning runaway".

**Test D**: `renderRunSummary` with `staged.runawayRetries === 0` (or absent) does NOT
include "runaway" in staged section (regression guard).

## Supporting updates

- `package.json`: bump to `0.0.242`
- `roadmap.md`: mark `- [x] 242 Surface Staged-Runaway and Heal-Overflow Events in CLI`
- `process/decisions.jsonl`: note "phase 242 closes the forensics gap: summary.json events
  now surfaced in terminal for repair_context_overflow and staged runawayRetries"
- `NEXT.md`: no candidate to delete (242 is a follow-on to 240+241, not from NEXT.md)
- `blog/242-surface-runaway-overflow-in-cli.md`: short post explaining what was added and why

## Done Criteria

- [x] `repair_context_overflow` stop reason renders a targeted message in terminal output
- [x] `healContextOverflowRetries > 0` annotates the repair result line
- [x] `staged.runawayRetries > 0` annotates the staged run output  
- [x] Four unit tests in the test suite (A, B, C, D above)
- [x] All existing tests pass
- [x] `npm run format` clean, `npm run check` clean
- [x] Blog post written
