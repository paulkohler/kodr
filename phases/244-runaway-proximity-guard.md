# Phase 244: Reasoning-Runaway Proximity Guard

## Motivation

`isReasoningRunaway` (`healing.mjs:154`) fires on `finish_reason=length` + zero
answer tokens. It currently has no knowledge of the completion cap (`max_tokens`)
that was in the request. A theoretical false-positive: a model call at a very low
cap where `finish_reason=length` fires due to truncation but the token count is
far below the cap (e.g., a context-window limit, not the cap, cut it off).

The phase-242 dogfood confirmed genuine runaways are at-cap: 4094/4096 tokens.
The proximity guard formalises this: only classify as runaway when
`completionTokens >= cap × 0.95`. This improves precision at both call sites:

- **Heal path** (`healing.mjs:369`): cap is `options.completionReserve` (4096)
- **Staged-retry path** (`run-pipeline.mjs:~1970`): cap is `max(completionReserve, 8192)`

When `cap` is not provided (backward compat, injected-mock tests), the predicate
falls back to the current behavior (returns true on finish_length + empty).

## Implementation

### 1. Extend `isReasoningRunaway` signature in `src/healing.mjs`

```js
// Add optional cap parameter (default null = uncapped, backward-compatible)
export function isReasoningRunaway(text, raw, proposalNonEmpty, cap = null) {
    if (proposalNonEmpty) return false;
    if ((text || '').trim().length > 0) return false;
    if (!raw) return false;
    const finishLength =
        raw.finishReasons?.at(-1) === 'length' ||
        raw.loopBudget?.stopReason === 'finish_length';
    if (!finishLength) return false;
    // Proximity guard: when we know the cap, require near-cap token usage.
    // Genuine runaways burn their full budget (phase-242: 4094/4096). A
    // finish_reason:length at far below cap indicates a different truncation
    // cause (e.g. context window, not max_tokens).
    if (cap != null) {
        const completionTokens = raw.loopBudget?.completionTokens ?? Infinity;
        return completionTokens >= cap * 0.95;
    }
    return true;
}
```

### 2. Pass cap at call sites

**`src/healing.mjs:369`** — heal turn call site. The cap is
`options.completionReserve` (set by `repairOptions` in `run-pipeline.mjs:2650`):

```js
// Before:
isReasoningRunaway(completion.text, completion.raw, turnProposalNonEmpty)

// After:
const healCap = (typeof options.completionReserve === 'number' && options.completionReserve > 0)
    ? options.completionReserve : null;
isReasoningRunaway(completion.text, completion.raw, turnProposalNonEmpty, healCap)
```

**`src/run-pipeline.mjs` staged-retry call** (Phase 240 insertion, around line
1965). The staged-retry cap is `Math.max(completionReserve, 8192)`:

```js
const stagedCap = Math.max(
    Number.isInteger(options.completionReserve) && options.completionReserve > 0
        ? options.completionReserve : 0,
    8192,
);
// Pass stagedCap to isReasoningRunaway
if (!stageDraftNonEmpty && isReasoningRunaway(completion.text, completion, false, stagedCap)) {
```

### 3. Tests in `test/healing.test.mjs`

Add to the existing `isReasoningRunaway` test group:

**Test A** — near-cap (4094/4096): `isReasoningRunaway('', raw4094, false, 4096)` → `true`

**Test B** — far-below-cap (100 tokens, cap 4096): `isReasoningRunaway('', raw100, false, 4096)` → `false`

**Test C** — no cap (backward compat): `isReasoningRunaway('', rawLength, false)` → `true`

**Test D** — near-cap (7800/8192 staged): `isReasoningRunaway('', raw7800, false, 8192)` → `true`

Where `rawXYZ` is `{ finishReasons: ['length'], loopBudget: { completionTokens: XYZ } }`.

## Supporting updates

- `package.json`: bump to `0.0.244`
- `roadmap.md`: mark `- [x] 244 Reasoning-Runaway Proximity Guard`
- `process/decisions.jsonl`: note proximity threshold 0.95, evidence from phase-242
  dogfood (4094/4096 genuine runaway), backward-compat null default
- `NEXT.md`: delete the "Reasoning-runaway proximity guard" candidate
- `blog/244-runaway-proximity-guard.md`

## Done Criteria

- [ ] `isReasoningRunaway` accepts optional `cap` parameter, returns false when
  `completionTokens < cap × 0.95`
- [ ] Heal call site passes `completionReserve` as cap
- [ ] Staged-retry call site passes `max(completionReserve, 8192)` as cap
- [ ] Four new tests covering near-cap true, far-below false, no-cap true, staged-cap
- [ ] All existing tests pass (null default preserves current behavior)
- [ ] `npm run format` clean, `npm run check` clean
- [ ] Blog post written
