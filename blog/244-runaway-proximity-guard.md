# Phase 244: Reasoning-Runaway Proximity Guard

`isReasoningRunaway` has one job: detect when a model spent its full token budget
on chain-of-thought reasoning and produced no answer. The signal it reads is
`finish_reason=length` plus zero answer content. Phase 231 introduced it; phases
234 and 240 extended it to the staged-retry path. It has worked well in practice.

But there is a theoretical false-positive. `finish_reason=length` fires whenever
the token stream hits any limit — including the model's context window, not just
the `max_tokens` cap set in the request. If a repair request runs into the context
window at, say, 300 tokens into a large prompt, `finish_reason=length` fires and
the answer is empty. Under the old code that would be classified as a reasoning
runaway even though the model never had a chance to produce output.

The phase-242 dogfood made the fix obvious. The SQLite notes API runaway hit
4094 of 4096 tokens — essentially dead-on the cap. Genuine runaways burn their
whole budget. A context-window limit that fires early would look completely
different: 300 tokens, cap 4096, same signal.

## The guard

The fix is a single parameter added to `isReasoningRunaway`:

```js
export function isReasoningRunaway(text, raw, proposalNonEmpty, cap = null)
```

When `cap` is provided, the predicate adds one more condition: the completion
token count must be at least 95% of the cap. Below that threshold the function
returns `false` even if `finish_reason=length` and content is empty.

```js
if (cap != null) {
    const completionTokens = raw.loopBudget?.completionTokens ?? Infinity;
    return completionTokens >= cap * 0.95;
}
return true;
```

The `?? Infinity` fallback handles the case where `loopBudget` is absent. If we
cannot measure the token count we assume it is at-cap — preserving the existing
behavior rather than creating a blind spot.

## Wiring it in

Two call sites needed updating.

The heal path in `healing.mjs` now derives `healCap` from `options.completionReserve`
(the value written into `repairOptions` in `run-pipeline.mjs` — 4096 for the default
qwen3.6 profile). If `completionReserve` is not a positive number the cap falls back
to `null` and the guard is inert.

The staged-retry path in `run-pipeline.mjs` already computed a `stagedCap` concept
implicitly (it used `completionCapMode:'staged-retry'` which resolves to
`max(completionReserve, 8192)` inside `applyCompletionCap`). The phase makes this
explicit: `stagedCap = Math.max(completionReserve ?? 0, 8192)` is computed at the
call site and passed as the fourth argument.

## Backward compatibility

The `cap = null` default means every existing call without a cap argument continues
to work exactly as before. All the phase-231 integration tests pass `raw` with
`completionTokens: 21693` and no cap — they return `true` unchanged. The
truth-table test gains four new cases but the existing seven are untouched.

## The four new tests

- **244A**: `completionTokens: 4094, cap: 4096` → true (4094/4096 = 99.9%, above 95%)
- **244B**: `completionTokens: 100, cap: 4096` → false (100/4096 = 2.4%, below 95%)
- **244C**: no cap → true (backward compat, even with only 999 completion tokens)
- **244D**: `completionTokens: 7800, cap: 8192` → true (95.2%, just above the threshold)

Test B is the key regression guard: it proves a low-token early truncation no longer
triggers a runaway classification when the cap is known.
