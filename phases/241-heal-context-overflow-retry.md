# Phase 241: Heal HTTP-400 Context-Overflow Detection and Retry

## Motivation

Two dogfoods reproduced a `stopReason: 'repair_error'` HTTP-400 "Context size has
been exceeded" after a context-heavy staged run (`phase-231/heal-runaway-3` turn-3,
`final-audit-2/content-api` turn-1). The naive explanation — kodr over-sending the
repair prompt — was disproven: `final-audit-2` turn-1 had an EMPTY repair context
(`files:[]`), ~14k char prompt, no `raw-response.json`, yet 400'd after 207s on the
FIRST request.

**Code-level diagnosis (phase 241 pre-implementation):**

- `run-pipeline.mjs` builds `repairOptions` with NO session ID or KV-cache hints
- `requestRaw` in `model-client.mjs` sends no session headers whatsoever
- Every heal request is a fresh stateless HTTP POST to `/v1/chat/completions`
- A 14k char prompt (~3–4k tokens) cannot exceed a 32k context window on its own

**Conclusion:** The 400 is LM Studio-side — its internal KV-cache from the heavy main
loop (77k cumulative prompt tokens across turns) occupies GPU memory and LM Studio
erroneously counts it against the context budget for the next incoming request.

**Fix strategy:** Detect the specific HTTP-400 + "Context size" error in the heal
repair turn, classify it as `repair_context_overflow` (distinct from generic
`repair_error`), and retry once. Retrying gives LM Studio a window to flush its
cached state. If the retry also 400s, surface the distinct stop reason so it is
diagnosable without manual artifact inspection.

## Implementation Steps

### 1. `src/model-client.mjs` — export `isContextOverflow(error)` helper

```js
/** True when a ModelClientError is an LM Studio HTTP-400 "Context size exceeded". */
export function isContextOverflow(error) {
    return (
        error instanceof ModelClientError &&
        error.details?.status === 400 &&
        /context.size|context window|exceeded/i.test(error.message)
    );
}
```

### 2. `src/run-pipeline.mjs` — retry in `repairTurn` callback

In the `repairTurn` async callback (around line 2660), wrap the completion call with
retry logic for context-overflow errors:

```js
repairTurn: async ({ prompt }) => {
    if (options.tools && registry) {
        registry.proposalDraft?.clear();
    }

    // Phase 241: one retry on context-overflow HTTP-400 (LM Studio KV-cache bleed).
    // The 200ms pause gives the server a window to flush its session state.
    const callCompletion = () =>
        options.tools && registry
            ? completeWithToolCalls(repairOptions, model, prompt, systemPrompt, registry)
            : completeWithContinuations(repairOptions, model, prompt, systemPrompt);

    let completion;
    try {
        completion = await callCompletion();
    } catch (firstError) {
        if (!isContextOverflow(firstError)) throw firstError;
        // Classify and record, then retry once.
        contextOverflowRetries += 1;
        await new Promise((resolve) => setTimeout(resolve, 200));
        completion = await callCompletion();   // propagate if this also throws
    }

    // ... rest of existing callback unchanged
```

`contextOverflowRetries` is a `let` declared before `runSelfHealingLoop` (alongside
`repairOptions`). Its value is included in the run summary for diagnostics.

### 3. `src/healing.mjs` — new `repair_context_overflow` stop reason

In the `catch (error)` block inside the heal turn loop (around line 291), add a
branch before the generic `repair_error` fallback:

```js
} catch (error) {
    const elapsedMs = Date.now() - turnStart;
    const serialized = serializeError(error);
    const isTimeout = error instanceof HealingTimeoutError;
    const isContextOverflow = error.name === 'ModelClientError' &&
        /context.size|context window|exceeded/i.test(error.message) &&
        error.details?.status === 400;
    stopReason = isTimeout
        ? 'timeout'
        : isContextOverflow
            ? 'repair_context_overflow'
            : 'repair_error';
    // ... rest unchanged
```

This ensures that if the retry in `repairTurn` also 400s, the loop surfaces
`repair_context_overflow` instead of the opaque `repair_error`.

**Alternative**: import `isContextOverflow` from `model-client.mjs` into `healing.mjs`
to avoid duplicating the regex. Prefer the import if it keeps the test clean.

### 4. `src/run-pipeline.mjs` — include in run summary

Add `healContextOverflowRetries` to the summary output when non-zero:

```js
if (contextOverflowRetries > 0) {
    meta.healContextOverflowRetries = contextOverflowRetries;
}
```

### 5. `test/healing.test.mjs` — add two tests

**Test A:** `repairTurn` throws context-overflow error on first call, succeeds on retry.
Assert: healing completes, retry happened (contextOverflowRetries in mock), no
`repair_context_overflow` stop reason (success path).

**Test B:** `repairTurn` throws context-overflow error on BOTH calls.
Assert: `stopReason === 'repair_context_overflow'`, loop exits, `repairs[0].ok === false`.

**Test C (model-client):** `isContextOverflow(error)` returns true for HTTP-400 with
"Context size exceeded", false for HTTP-400 without, false for HTTP-500, false for
non-ModelClientError.

### 6. Supporting updates

- `package.json`: bump to `0.0.241`
- `roadmap.md`: mark `- [x] 241 Heal Context-Overflow Retry`
- `process/decisions.jsonl`: record "code-level diagnosis disproved session-reuse
  hypothesis; fix is detect+retry+classify; 200ms pause gives LM Studio flush window"
- `process/failures.jsonl`: add entry for the two dogfood reproduces with updated
  diagnosis (LM Studio KV-cache bleed, NOT kodr prompt size)
- `NEXT.md`: delete the "Heal request HTTP-400" candidate
- `blog/241-heal-context-overflow-retry.md`: capture diagnosis, fix, symmetry with
  phase-231

## Done Criteria

- [x] `isContextOverflow(error)` exported from `model-client.mjs`
- [x] `repairTurn` retries once on context-overflow HTTP-400, 200ms pause
- [x] `contextOverflowRetries` counter in run summary when non-zero
- [x] `heal.mjs` emits `repair_context_overflow` stop reason when retry also fails
- [x] Tests: context-overflow-then-success, double-overflow (stop reason), isContextOverflow unit
- [x] All existing tests pass
- [x] `npm run format` clean, `npm run check` clean
- [x] Blog post written
