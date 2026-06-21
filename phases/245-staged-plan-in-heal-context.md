# Phase 245: Include Staged Plan in Heal Repair Context

## Motivation

Phase-242-audit: the heal model kept hypothesising "database reset" rather than
the actual root cause — the staged plan's `scratchpad` contained `r[0]/r[1]/r[2]`
positional indexing, which was then faithfully implemented in `db.mjs`. The heal
model had the written files (including `db.mjs`) but not the plan text that
introduced the bug.

When a staged run fails verification, the repair context includes the test output
and written files, but NOT the staged plan (the `plan` stage's scratchpad text).
Including the plan as context gives the repair model:
- What the implementation was intended to do (design intent)
- The reasoning at plan time that may contain the root-cause assumption
- Stage grouping — which files belong to the same stage

## Implementation

### 1. Capture plan text in `runStagedPrompt` result (`src/run-pipeline.mjs`)

The plan stage response (scratchpad) is already used to build subsequent stage
prompts via `stageContext.systemPrompt` (line ~1939). It is NOT currently returned
in the staged result summary. Extract it:

After `runStagedPrompt` resolves, the `stageRecords` array has the plan record at
index 0 (name: `'plan'`). The plan response text is the `lastText` captured at
the plan stage.

Add a `planScratchpad` field to the staged result returned from `runStagedPrompt`:

```js
// In the return object of runStagedPrompt (around line ~2393):
return {
    // ... existing fields ...
    planScratchpad: planScratchpad || '',   // plan stage scratchpad for heal context
};
```

Where `planScratchpad` is declared and captured when the plan stage completes
(when `stageIndex === 0` and `stageRecord.name === 'plan'`).

Look for where `stageRecords` is pushed in the plan stage and capture the scratchpad
text at that point.

### 2. Pass to `runHealingIfNeeded` (`src/run-pipeline.mjs`)

`runHealingIfNeeded` is called with options. Extend the call to include the staged
plan when available:

```js
// In runHealingIfNeeded call after staged run (around line ~2655):
return runSelfHealingLoop(cwd, testResult, {
    // ... existing options ...
    stagedPlan: stagedResult?.planScratchpad || '',  // new field
});
```

### 3. Thread through `buildRepairContext` (`src/healing.mjs`)

The `buildRepairContext` call at line ~253 already passes `originalTask` and
`scratchpad`. Add `stagedPlan`:

```js
// In runSelfHealingLoop:
const repairContext = await buildRepairContext(cwd, verification, {
    scratchpad,
    originalTask: options.originalTask || '',
    stagedPlan: options.stagedPlan || '',   // new
});
```

In `buildRepairContext` itself (line ~632):
```js
return {
    // ... existing fields ...
    stagedPlan: options.stagedPlan || '',
};
```

### 4. Include in repair prompt when present (`src/healing.mjs`)

In `renderLoopRepairPrompt` (the main repair prompt renderer, around line ~671),
add the staged plan section:

```js
const stagedPlanSection = repairContext.stagedPlan
    ? `\n\n## Implementation plan (from staged run)\n${repairContext.stagedPlan}`
    : '';
```

Inject it into the prompt after the `originalTask` section but before the files:

```
${stagedPlanSection}
```

The section header "Implementation plan (from staged run)" signals to the model
that this is a plan from a prior run — context, not instruction.

### 5. Tests

**Test A**: `buildRepairContext` with `options.stagedPlan = 'plan text'` returns
a context with `stagedPlan: 'plan text'`.

**Test B**: `renderLoopRepairPrompt` with a non-empty `stagedPlan` in the context
includes "Implementation plan" in the rendered prompt.

**Test C**: `renderLoopRepairPrompt` with an empty/absent `stagedPlan` does NOT
include the plan section (regression guard).

## Supporting updates

- `package.json`: bump to `0.0.245`
- `roadmap.md`: mark `- [x] 245 Staged Plan in Heal Repair Context`
- `process/decisions.jsonl`: note "staged plan text passed to repair context so
  heal model has design intent; evidence: phase-242 audit heal loop hypothesised
  wrong cause without plan"
- `NEXT.md`: delete the "Include staged plan in heal repair context" candidate
- `blog/245-staged-plan-in-heal-context.md`

## Done Criteria

- [x] `runStagedPrompt` captures and returns `planScratchpad` from the plan stage
- [x] `runHealingIfNeeded` passes `stagedPlan` from the staged result to the heal loop
- [x] `buildRepairContext` includes `stagedPlan` in the returned context object
- [x] `renderLoopRepairPrompt` includes "Implementation plan" section when non-empty
- [x] Three tests: buildRepairContext passes through, prompt includes section, empty guard
- [x] All existing tests pass
- [x] `npm run format` clean, `npm run check` clean
- [x] Blog post written
