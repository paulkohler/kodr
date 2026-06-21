# Phase 245: Staged Plan in Heal Repair Context

The phase-242 SQLite audit exposed a specific failure mode in the heal loop: the
repair model kept hypothesising "database reset" as the root cause of the failing
tests, even though the real bug was staring at it from `db.mjs`. The `r[0]`,
`r[1]`, `r[2]` positional row accesses that caused the failures had come directly
from the staged plan's scratchpad — the plan had specified the implementation in
those terms, the code stage faithfully reproduced it, and then the heal model had
no way to see the reasoning that introduced the pattern.

The repair prompt at that point contained: the failing test output, the written
files (including the buggy `db.mjs`), and the original user task. What it did not
contain: the staged plan itself.

That is the gap this phase closes.

## What gets passed

In `runStagedPrompt`, the plan stage runs first and its scratchpad is captured in
the local `scratchpad` variable. The rest of the staged execution uses this as the
"current staged plan" appended to each stage prompt. But when the run finishes and
the heal loop starts, that scratchpad was never forwarded anywhere — it went into
`scratchpad.md` on disk and nowhere else.

The fix adds one local binding immediately after the plan stage:

```js
scratchpad = planProposal?.scratchpad || '';
const planScratchpad = scratchpad;   // Phase 245: snapshot before execution stages mutate it
```

`planScratchpad` is then returned in the staged result object and passed through
`runHealingIfNeeded` (new `stagedPlan` parameter) down to `runSelfHealingLoop` →
`buildRepairContext`.

## The prompt section

`renderLoopRepairPrompt` receives the plan via `repairContext.stagedPlan` and emits
it between the original-task section and the diagnostics:

```
## Implementation plan (from staged run)
<plan text here>
```

The section header signals to the repair model that this is context from a prior
generation, not a new instruction. When `stagedPlan` is empty or absent the section
is omitted entirely — non-staged heal runs are unaffected.

## What the test covers

Three tests were added to `healing.test.mjs`:

- **Test A**: `buildRepairContext` with `options.stagedPlan` set returns a context
  with `stagedPlan` equal to the input string. Direct pass-through verification.

- **Test B**: `renderLoopRepairPrompt` with a non-empty `stagedPlan` in the context
  includes "Implementation plan (from staged run)" in the output, and the plan text
  appears verbatim.

- **Test C**: `renderLoopRepairPrompt` with an empty `stagedPlan` string, and again
  with no `stagedPlan` key at all, both produce prompts that do NOT contain
  "Implementation plan". This is the regression guard for non-staged heal runs.

`renderLoopRepairPrompt` had to be exported to make test B and C possible — it was
previously a module-private function. The export is consistent with
`renderEscalationPrompt`, which has been exported since phase 125.

## The original failure, replayed

In the phase-242 run the staged plan contained:

```
Stage 2: db.mjs — use StatementSync.all() and access rows as r[0], r[1], r[2]
```

The code faithfully produced `return { key: r[0], value: r[1] }`. The tests failed
because `StatementSync.all()` returns named-column objects, not arrays. The heal
model received `db.mjs`, saw `r[0]` is undefined, and spent its entire token budget
reasoning about whether the database had been reset between writes.

With this phase, the repair prompt would have included the plan stage text. That
text names the exact API shape the implementation was meant to use — and names the
wrong assumption (`r[0]` indexing) that a competent repair model should catch.

Whether a local model will actually catch it is a separate question. The harness now
gives it the evidence it needs.
