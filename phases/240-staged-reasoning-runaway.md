# Phase 240: Staged Reasoning-Runaway Fast-Fail

## Motivation

Phase 231 added `isReasoningRunaway` to detect heal-turn reasoning exhaustion.
Phases 234/236 added a honoured `max_tokens` completion cap, scoped to heal turns
only after the phase-236 probe showed a 4096 cap starved a staged generate turn.

The staged implement turns remain uncapped. Phase-238-audit (rest-api-sqlite-2)
observed the identical failure mode:

- `finish_reason=length`, `content_len=0`, 23k completion tokens burned on CoT
- 0 tool_calls, `ProposalMissingError` aborted the stage
- Turn 11, prompt=9709, 32768 context — model had 23k token budget and spent all of it

Evidence: `phase-238-audit/rest-api-sqlite-2/.kodr/runs/2026-06-20T22-03-43.228Z/`
conversation.json turn 11, summary.json staged.stages[1].

## Fix: Detect-and-Retry (not a blanket cap)

A blanket `completionCapMode:'staged'` risks starving large file generation
(phase-236 probe: 4096 cap, 0 answer chars on a two-file task). The safer approach:

1. After each staged implement turn, call `isReasoningRunaway(completion.text, completion, false)`.
2. If it fires: record the runaway evidence on the stage record, then retry once at
   `max(completionReserve, 8192)`. This floor is the minimum safe bound from the
   phase-236 probe — large files need more room than the 4096 heal cap.
3. If the retry also fires (or produces no proposal): let the existing
   `ProposalMissingError` path abort the stage. No infinite loop.

The new `completionCapMode: 'staged-retry'` is added to `applyCompletionCap` in
`model-client.mjs`, using `max(completionReserve, 8192)` instead of the bare
`completionReserve` used for heal turns.

## Implementation Steps

### 1. `src/healing.mjs` — export `isReasoningRunaway`
`isReasoningRunaway` is already defined here. Confirm it is exported. If not,
add it to the named exports.

### 2. `src/run-pipeline.mjs` — import and wire the check
a. Add `isReasoningRunaway` to the import from `./healing.mjs`.

b. In `runStagedPrompt`, after `const completion = await completeWithToolCalls(...)`,
   insert a runaway detection block:

```js
// Phase 240: staged reasoning-runaway fast-fail.
// isReasoningRunaway reuses the same predicate as the heal loop (phase 231).
// `completion` has .finishReasons and .loopBudget — the same fields the predicate
// reads from the `raw` argument. Only fire when content is also empty (no draft).
const draftBeforeCheck = ProposalDraft.get(registry);
const stageDraftNonEmpty = draftBeforeCheck && draftBeforeCheck.files.length > 0;
if (!stageDraftNonEmpty && isReasoningRunaway(completion.text, completion, false)) {
    const lb = completion.loopBudget || {};
    const runawayEvidence = {
        finishReason: completion.finishReasons?.at(-1) ?? null,
        completionTokens: lb.completionTokens ?? null,
        promptTokens: lb.promptTokens ?? null,
        totalTokens: lb.tokens ?? null,
        stageIndex,
    };
    const stagedCap = Math.max(
        Number.isInteger(options.completionReserve) && options.completionReserve > 0
            ? options.completionReserve : 0,
        8192,
    );
    const retryOpts = { ...options, inStagedPipeline: true, completionCapMode: 'staged-retry' };
    const retryCompletion = await completeWithToolCalls(
        retryOpts, model, stagePrompt, stageContext.systemPrompt, registry,
    );
    responses.push(...retryCompletion.responses);
    finishReasons.push(...retryCompletion.finishReasons);
    conversations.push(...retryCompletion.messages);
    lastText = retryCompletion.text;
    completion = retryCompletion;
    // Mark this stage iteration so summary.json reflects the retry.
    stagedRunawayRetries = (stagedRunawayRetries | 0) + 1;
    currentStageRunawayEvidence = runawayEvidence;
}
```

Note: `stagedRunawayRetries` and `currentStageRunawayEvidence` are variables
declared before the stage loop. Reset `currentStageRunawayEvidence = null` at
the top of each stage iteration.

c. When pushing a stage record (after writes are applied), include:
   - `runawayRetry: true` if `currentStageRunawayEvidence` is non-null
   - `runaway: currentStageRunawayEvidence` with the evidence object

d. In the `staged` block of the run summary, add `stagedRunawayRetries` count.

### 3. `src/model-client.mjs` — extend `applyCompletionCap`

In the `applyCompletionCap` function, extend the `completionCapMode` check:

```js
function applyCompletionCap(options, body) {
    if (options.completionCapMode !== 'heal' && options.completionCapMode !== 'staged-retry') {
        return body;
    }
    // staged-retry: floor at 8192 so a large file generate is not starved.
    // heal: use completionReserve directly (tight 4096 is intentional for fast-fail).
    const cap = options.completionCapMode === 'staged-retry'
        ? Math.max(
            Number.isInteger(options.completionReserve) && options.completionReserve > 0
                ? options.completionReserve : 0,
            8192,
        )
        : options.completionReserve;
    if (!Number.isInteger(cap) || cap <= 0) return body;
    if (Object.hasOwn(body, 'max_tokens') || Object.hasOwn(body, 'max_completion_tokens')) {
        return body;
    }
    return { ...body, max_tokens: cap };
}
```

### 4. `test/staged-pipeline.test.mjs` — add three tests

**Test A**: Stage 1 runaways (length + empty), retry returns a valid proposal.
Assert: stage record has `runawayRetry: true`, file is written, `staged.stages[0].writeCount >= 1`.

**Test B**: Stage 1 runaways, retry also runaways.
Assert: `writeError.name === 'ProposalMissingError'`, no retry loop, stage exits.

**Test C**: Stage 1 returns `finish_reason=stop` with empty content (not a runaway).
Assert: falls through to `ProposalMissingError` directly, no `runawayRetry` in record.

Use the existing fake-model server pattern in the file for request sequencing.

### 5. Supporting updates
- `package.json`: bump version to `0.0.240`
- `roadmap.md`: mark `- [x] 240 Staged Reasoning-Runaway Fast-Fail`
- `process/decisions.jsonl`: record detect-and-retry choice, 8192 floor, phase-236 evidence
- `NEXT.md`: delete the staged reasoning-runaway candidate block
- `blog/240-staged-reasoning-runaway.md`: capture the problem, the fix, and the symmetry with phase 231

## Done Criteria

- [x] `isReasoningRunaway` is imported and called in `runStagedPrompt`
- [x] Runaway detection fires only on `finish_reason=length` + zero content + no draft
- [x] Retry uses `completionCapMode:'staged-retry'` with `max(completionReserve, 8192)` floor
- [x] Stage record carries `runawayRetry: true` + `runaway` evidence when retry fired
- [x] `applyCompletionCap` handles `staged-retry` mode
- [x] Three new tests pass: retry-succeeds, double-runaway, stop-empty (regression guard)
- [x] All existing tests pass
- [x] `npm run format` clean, `npm run check` clean
- [x] Blog post written
