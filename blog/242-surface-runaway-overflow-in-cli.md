# Phase 242: Surface Staged-Runaway and Heal-Overflow Events in CLI Output

Phases 240 and 241 added diagnostic metadata to `summary.json`: a `staged.runawayRetries`
counter when a staged implement turn hit `finish_reason=length` with zero content and was
retried, and a `healContextOverflowRetries` counter plus a `repair_context_overflow` stop
reason when LM Studio KV-cache bleed caused an HTTP 400 on a repair turn.

Neither event appeared in the terminal. The user saw `Run failed` with no explanation.
The forensics were buried in `summary.json`.

## What was missing

`run-summary.mjs` already had the pattern: `reasoning_runaway` and `timeout` both got
targeted messages in the healing result block, explaining what went wrong and how to
recover. The two new events from 240 and 241 were recorded but never rendered.

## What was added

Three additions to `renderRunSummary`:

**`repair_context_overflow` stop reason** — a new `else if` branch after `reasoning_runaway`
in the healing result block. When `healingResult.stopReason === 'repair_context_overflow'`,
the terminal now prints a targeted message naming the HTTP 400, the LM Studio KV-cache
mechanism, and the remediation (retry the run or restart LM Studio).

**`healContextOverflowRetries` annotation** — placed after the main heal stop-reason line,
for all stop reasons. When `hr.healContextOverflowRetries > 0`, a parenthetical note is
appended: how many repair turns hit the 400 and were retried before either succeeding or
giving up with `repair_context_overflow`.

**`staged.runawayRetries` annotation** — placed before the test result block. When
`result.staged?.runawayRetries > 0`, a note describes how many staged implement turns hit
reasoning runaway and were retried with a capped `max_tokens`. Optional chaining on
`result.staged` ensures it is silent when the staged pipeline was not used.

## The forensics gap it closes

Before this phase, a user whose heal turn failed with `repair_context_overflow` had to open
`summary.json`, find `stopReason`, and cross-reference it against the phase 241 code to
understand what happened. After this phase, the terminal output names the failure mode,
describes the LM Studio KV-cache mechanism, and tells them what to do.

The same is true for staged runaway retries. A run that silently retried twice is now
annotated in the terminal output. The user can see that the model misbehaved and that
kodr recovered, rather than wondering why the run was slow or finding the counter buried
in `summary.json`.

## Tests

Four unit tests in `test/run-summary.test.mjs`:

- **Test A**: `repair_context_overflow` stop reason renders a message containing
  "repair_context_overflow" and "HTTP 400".
- **Test B**: `stopReason === 'healed'` with `healContextOverflowRetries === 2` renders
  the annotation containing "2 repair turn(s) hit HTTP-400 context overflow".
- **Test C**: `staged.runawayRetries === 1` renders the annotation containing
  "1 staged implement turn(s) hit reasoning runaway".
- **Test D**: `staged.runawayRetries === 0` or `staged` absent does NOT render the
  runaway annotation — regression guard.
