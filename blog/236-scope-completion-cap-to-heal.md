# Phase 236: The Cap That Helped Heal and Starved Generation

Phase 234 wired a real improvement: a honored `max_tokens` completion cap that
converts a reasoning-token runaway from a 200–330 second grind into a sub-second
`finish_reason: length` that phase 231's fast-fail predicate catches immediately.
The cap value is `options.completionReserve` — 4096 for qwen3.6. And it applied
to every request.

That last part turned out to be a problem.

## The probe that caught it

Before committing to an ambitious multi-file dogfood, a sanity probe ran the same
generation task under two conditions: the phase-234 cap, and no cap.

| setup | finish_reason | completion toks | reasoning toks | answer chars |
|---|---|---|---|---|
| `max_tokens: 4096` (phase-234 cap) | **length** | 4096 | **4095** | **0** |
| no cap (pre-234 main-loop behavior) | **stop** | 10610 | 7299 | 11378 (complete) |

The capped run produced nothing. The thinking model spent the entire 4096-token
budget on reasoning and emitted zero answer characters. `finish_reason: length`
fired not because the model ran away — it was trying to do real work — but because
4096 tokens is not enough for this task on this model.

The uncapped run needed ~10.6k completion tokens and completed both files with a
11378-character answer.

## Why the SUM matters

The phase-234 probe established that for qwen3.6 on LM Studio, `max_tokens` caps
the **sum** of reasoning and answer tokens, not reasoning alone. The three
thinking-specific parameters (`max_thinking_tokens`, `reasoning_effort`, nested
`reasoning.max_tokens`) are all silently ignored. Only `max_tokens` and
`max_completion_tokens` are honored, and they both bound the combined total.

On a heal turn, this is exactly what you want. A reasoning runaway burns the cap
on reasoning and returns `finish_reason: length` fast — sub-second instead of
200–330s. Phase 231 catches it. The cap is invisible to healthy heal turns: a
normal heal completion uses ~1601 tokens total, well under 4096.

On the main generation loop, the same cap is hostile. A complex sub-turn may need
far more than 4096 tokens to reason through a multi-step problem and emit a tool
call. The cap bites mid-reasoning, returns `finish_reason: length` with nothing
emitted, and the agentic loop retries — repeating the wasted sub-turn until the
sub-turn budget (`maxTurns`) is exhausted. In the worst case, like the probe, the
model never gets to write anything at all.

## Why phase 234 missed it

The phase-234 dogfood (`phase-234/cap-wiring-1`) used small files — a unicode
text-stats CLI with a counter module, a CLI module, and a test file. The model
generated them in a handful of sub-turns, total. The cap never bit. The
reasoning and answer tokens for that task fit comfortably under 4096, so the run
was clean and the phase shipped as correct.

The ambitious multi-file audit dogfood that followed would have hit the cap
immediately. The probe intercepted it first.

## The fix: mark the heal options bag

The heal request bag `repairOptions` is constructed in exactly one place in
`src/run-pipeline.mjs`, at the start of the self-healing sequence. It is the only
options bag that flows into the heal `repairTurn` callback. Adding a single
marker to it cleanly and uniquely identifies heal requests at the wire layer.

Two changes:

**`src/run-pipeline.mjs` ~2575** — add `completionCapMode: 'heal'` to the
`repairOptions` spread:

```js
const repairOptions = {
    ...options,
    maxRetries: Math.min(options.maxRetries, 1),
    maxTurns: healRepairTurnBudget(options.maxTurns),
    completionCapMode: 'heal',
};
```

**`src/model-client.mjs` ~167** — add an early-return gate at the top of
`applyCompletionCap`:

```js
if (options.completionCapMode !== 'heal') {
    return body;
}
```

Everything else in `applyCompletionCap` is unchanged: the positive-integer guard,
the caller-override guard, the `max_tokens: cap` injection. The three injectors
(`applyRequestParameters`, `applyCompletionCap`, `applyPromptCacheControl`) are
still composed in the same order inside `buildChatRequestBody`. The heal wire shape
is byte-identical to phase 234.

## What reverts, what stays

The main loop and staged path now revert to their known-good pre-234 uncapped
behavior. No `max_tokens` is injected when the options bag has no marker. This
is the exact wire shape that was shipping before phase 234, and it is known good:
the main loop has its own bounds (per-turn timeout, `maxTurns` sub-turn budget)
that are independent of a wire cap.

The heal path is unchanged. Heal turns still carry `max_tokens: completionReserve`
on the wire. Phase 231's runaway fast-fail fires as before. Phase 234's and
phase 235's behaviors are byte-identical.

## Why not raise completionReserve?

`completionReserve` is not just a wire cap value — it is also the answer-room
reservation used by context-packing across the codebase. Raising it to un-starve
the main loop would shrink the prompt budget for every request. And even a larger
flat cap is still a ceiling the pre-234 main loop never had. Trading one regression
for context-packing pressure is not an improvement.

## Why not a generous main-loop cap?

A cap such as `contextWindow - completionReserve` (e.g. 28672 for qwen3.6) would
almost never bite — but "almost never" is strictly worse than the known-good
"never" that comes from no cap at all. The wire layer does not know the prompt
token count, so any derived cap risks truncating legitimate work. The main loop
already has non-wire bounds. The correct fix is no cap for the main loop, not a
friendlier cap.

Design (C) — tight heal cap plus a generous main cap — is documented in NEXT.md
as a future option if ambitious dogfood ever reveals a genuine main-loop runaway
that the timeout and sub-turn budget cannot contain fast enough. That day has not
come. Choose the known-good baseline.

## Tests: 1877 → 1882

Five new tests in `test/model-client.test.mjs`, all in the existing
`describe('completion cap request shaping')` block:

The nine phase-234 tests that assert the cap is present now carry
`completionCapMode: 'heal'` in their options bags — same assertions, same values,
heal-scoped. The tests that assert no cap or caller-override now also carry the
heal marker where it is meaningful (proving override wins even on a heal turn).
The 0/negative/unset cases carry the marker so the positive-integer guard is
proven to still bite on a heal turn.

New regression tests (the phase-236 main-loop fix):
- Main-loop options (no `completionCapMode`) with positive `completionReserve` →
  no `max_tokens` injected. The regression this phase fixes.
- Explicit non-heal `completionCapMode: 'main'` → no cap (only `'heal'` triggers).
- Heal mode plus positive reserve → cap present (focused belt-and-suspenders).
- Main-loop bag with `maxThinkingTokens` → `max_thinking_tokens` present, `max_tokens`
  absent (proves `applyRequestParameters` is independent of the marker gate).
- Heal marker contract: `completionCapMode: 'heal'` fires, no marker does not —
  documents the exact string the run-pipeline sets and the gate checks.

All 1877 pre-existing tests pass unchanged, including the heal app tests in
`test/app.test.mjs`, the `isReasoningRunaway` tests in `test/healing.test.mjs`,
and the streaming thinking-token test that confirms `applyRequestParameters` is
unaffected.
