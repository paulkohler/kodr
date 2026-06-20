# Phase 236 — Scope the Honored Completion Cap to HEAL Turns Only (Un-Starve Main Generation)

## Motivation (the cap that helped heal and starved generation)

Phase 234 wired a **honored** wire-level completion cap —
`applyCompletionCap` (`src/model-client.mjs` ~167) injects
`max_tokens: options.completionReserve` into `buildChatRequestBody`. The cap's
purpose was narrow and good: on a HEAL turn a reasoning runaway hits the cap in
~1s and returns `finish_reason: length`, which phase-231's `isReasoningRunaway`
predicate fast-fails on, instead of LM Studio grinding the full 32K window for
200–330s.

But phase 234 applied that same tight cap to **ALL** requests — the main
generation loop AND staged generation AND heal — on the stated assumption that
"applying the cap everywhere is a one-line correctness win, not a heal-only
special case" (phase-234 file, "Heal path reaches the cap" section). **That
assumption is wrong for thinking models.** For qwen3.6 `completionReserve` is
4096; a substantial main-loop generation needs far more than that, and because
the honored cap bounds the **SUM** (reasoning + answer), a thinking model can burn
the entire 4096 on reasoning and emit **zero answer**.

### Live probe (2026-06-20, qwen/qwen3.6-35b-a3b, "write two full files with validation + tests")

A realistic generation task, varying only the cap:

| cap sent | finish_reason | completion toks | reasoning toks | answer chars |
|---|---|---|---|---|
| `max_tokens: 4096` (the phase-234 cap) | **length** | 4096 | **4095** | **0** |
| no cap (pre-234 main-loop behavior) | **stop** | 10610 | 7299 | 11378 (complete two-file answer) |

The 4096 cap caused **total truncation**: the model spent the whole budget on
reasoning and produced nothing. Uncapped, the same task needed **~10.6k completion
tokens** and succeeded. The flat 4096 cap starves legitimate work on this thinking
model.

### Why the agentic main loop is hit too

In the agentic main loop each sub-turn issues one tool call (`write_file` /
`edit_file` / `read_file`). A complex sub-turn can burn the full 4096 on reasoning
**before** emitting any tool call, returning `finish_reason: length` with no tool
call — a wasted sub-turn, repeated until the sub-turn budget (`maxTurns`) is
exhausted. The phase-234 dogfood (`phase-234/cap-wiring-1`) used **tiny** files and
never approached 4096, so it never surfaced this. The upcoming ambitious multi-file
audit dogfood would hit it immediately.

This is a real regression phase 234 introduced, caught here by pre-audit probing
before it broke the ambitious dogfood.

## Root cause (verified by reading)

`applyCompletionCap(options, body)` (`src/model-client.mjs:167-188`) injects
`max_tokens: cap` for **every** request whose `options.completionReserve` is a
positive integer and whose `body` does not already pin a cap. It has no notion of
*which kind* of request it is shaping. `buildChatRequestBody` (line 151) =
`applyPromptCacheControl(applyCompletionCap(applyRequestParameters(...)))`, and
`createChatCompletion` (line 82-83) builds the body once via
`buildChatRequestBody` for **all** call paths:

- **Main loop:** `completeWithToolCalls(options, …)` / `completeWithContinuations(options, …)`
  forward the base `options` (carrying `completionReserve` from
  `applyModelProfileDefaults`, `model-profiles.mjs:162-167`) → `createChatCompletion`
  → `buildChatRequestBody` → **`max_tokens: 4096`**. Starved.
- **Staged:** `runStagedPrompt` flows through the same main `createChatCompletion`
  path → also capped at 4096. Staged generation also needs room.
- **Heal:** `repairOptions = { ...options, … }` (`run-pipeline.mjs:2575`) → the
  `repairTurn` callback (~2590) → `completeWithToolCalls(repairOptions, …)` /
  `completeWithContinuations(repairOptions, …)` → same path → `max_tokens: 4096`.
  **This is the only place the cap is actually wanted.**

Pre-234 the main loop sent **no** `max_tokens` and is known-good. The agentic main
loop already has its own bounds — a per-turn timeout and the agentic sub-turn budget
(`maxTurns`) — so it does not need a tight runaway cap the way heal does.

## Heal is distinguishable at the wire layer (verified — minimal plumbing)

The heal request bag `repairOptions` is constructed in exactly one place
(`run-pipeline.mjs:2575`) and is the only options bag that flows into the heal
`repairTurn` callback. The main loop and staged paths never touch `repairOptions`.
So adding a single marker to `repairOptions` cleanly and uniquely distinguishes
heal requests at the wire layer (`applyCompletionCap` reads `options`).

`options.completionReserve` and `options.contextWindow` are both present on the
options bag at the wire layer (set together by `applyModelProfileDefaults`,
`model-profiles.mjs:159-177`), and `repairOptions` spreads `...options`, so both
survive on the heal bag.

## The fix — Design (A): scope the tight cap to HEAL only

**Chosen design: (A).** `applyCompletionCap` injects
`max_tokens: completionReserve` **only when the options carry a heal marker**. The
main loop and staged path revert to **UNCAPPED** — their known-good pre-234
behavior. This:

- removes the main-loop and staged truncation entirely (restores the pre-234
  known-good wire shape for those paths);
- preserves the phase-234 / phase-235 heal fast-fail **byte-identically** (heal
  turns still send `max_tokens: completionReserve`, so phase-231 runaway detection
  still fires fast);
- has the minimal blast radius — one new gate clause in `applyCompletionCap` and
  one marker assignment in `run-pipeline.mjs`.

### Correcting the phase-234 assumption

Phase 234 asserted "applying the cap everywhere is a one-line correctness win, not
a heal-only special case." **For thinking models this is false.** Because the
honored cap bounds the reasoning+answer SUM, a `completionReserve`-sized cap on a
real generation truncates legitimate work (probe: 4096 cap → 4095 reasoning tokens
+ 0 answer chars). The cap IS a heal-only special case — its only value is
converting a runaway into a fast `finish_reason: length`, which only the heal loop
acts on. This phase records that correction.

### Why NOT design (B) — raise completionReserve globally

Rejected. `completionReserve` is also the answer-room reservation used by
context-packing (`context-packer.mjs` `sessionContextCharsForProfile`,
`model-profiles.mjs:233-234`). Raising it to un-starve the main loop would
shrink the prompt budget for every request and conflate the heal-answer
reservation with the wire cap. It also wouldn't help: even a larger global cap is
still a flat ceiling on the main loop that pre-234 did not have. (B) trades one
regression for context-packing pressure. Reject.

### Why NOT design (C) — tight heal cap + generous main cap

Considered and rejected for this phase. (C) would keep heal at
`completionReserve` and give the main loop a generous cap such as
`contextWindow - completionReserve` so a true main-loop runaway still has a
deterministic bound while legitimate turns have room. But:

- The main loop is **already bounded** by the per-turn timeout and the agentic
  sub-turn budget, so it does not need a wire-level runaway ceiling the way heal
  does (heal's value is *speed* of fast-fail, which the timeout/budget cannot give
  in the wireNoStream non-streaming case).
- Any generous main cap derived at the wire layer risks truncating legit work,
  because the wire layer does not know the prompt token count. `contextWindow -
  completionReserve` (e.g. 32768 − 4096 = 28672 for qwen3.6) is generous enough
  that it would almost never bite — but "almost never" is strictly worse than the
  known-good pre-234 "never" for the same purpose, and it reintroduces a cap the
  main loop never had. The known-good baseline is uncapped; (A) restores exactly
  that.
- (A) is smaller, safer, and reverts to a proven-good state. Choose (A).

If ambitious dogfood ever shows a genuine main-loop runaway that the
timeout/budget does not contain in acceptable time, (C) is the documented
follow-up (recorded in NEXT.md), not this phase.

### 1. Gate `applyCompletionCap` on a heal marker (`src/model-client.mjs` ~167)

Add a single early-return gate: no heal marker → no cap (the main-loop / staged
known-good path). The existing positive-integer and caller-override guards are
preserved unchanged, after the marker gate.

```js
// Phase 234/236: inject a HONORED wire-level completion cap, scoped to HEAL turns.
// Probe (2026-06-20) against qwen3.6: max_thinking_tokens / reasoning_effort /
// nested reasoning.max_tokens are ALL ignored; only max_tokens / max_completion_tokens
// are honored, and they bound the SUM (reasoning + answer). On a heal turn a runaway
// hits the cap in ~1s -> finish_reason:length, which phase-231's isReasoningRunaway
// fast-fails on, instead of grinding the full context window for 200-330s.
//
// Phase 236: the cap is HEAL-ONLY. A second 2026-06-20 probe (a realistic two-file
// generation) showed the SAME completionReserve cap (4096) STARVES the main loop:
// the thinking model spent all 4096 on reasoning and emitted 0 answer chars
// (finish_reason:length), where the uncapped main loop needed ~10.6k completion
// tokens and succeeded. The main loop is already bounded by the per-turn timeout and
// the agentic sub-turn budget, so it does NOT need this wire cap. Apply it only when
// the heal path marks the options bag; the main loop / staged path revert to their
// known-good pre-234 uncapped wire shape. (Corrects phase 234's "apply to ALL
// requests" assumption — it is NOT universally correct for thinking models.)
function applyCompletionCap(options, body) {
	// Phase 236: heal-only. No heal marker -> no cap (main loop / staged stay
	// uncapped, their known-good pre-234 behavior).
	if (options.completionCapMode !== 'heal') {
		return body;
	}
	const cap = options.completionReserve;
	// Only a positive integer is a usable cap. '', undefined, 0, non-integers ->
	// no cap (don't break non-profile callers / tests that omit it).
	if (!Number.isInteger(cap) || cap <= 0) {
		return body;
	}
	// Caller override wins: if the request body already pins either honored cap,
	// leave it untouched.
	if (
		Object.hasOwn(body, 'max_tokens') ||
		Object.hasOwn(body, 'max_completion_tokens')
	) {
		return body;
	}
	// max_tokens is the more universally honored OpenAI field (probe shows it and
	// max_completion_tokens are identical for qwen3.6); prefer max_tokens.
	return {
		...body,
		max_tokens: cap,
	};
}
```

`buildChatRequestBody`, `applyRequestParameters`, and `applyPromptCacheControl`
stay **byte-identical** — only `applyCompletionCap`'s body changes (one added gate
clause at the top). The composition in `buildChatRequestBody`
(`applyPromptCacheControl(applyCompletionCap(applyRequestParameters(...)))`) is
unchanged.

### 2. Mark the heal options bag (`src/run-pipeline.mjs` ~2575)

`repairOptions` is the single, unique heal options bag. Add the marker there so
every heal request (tool-call channel and text channel) carries it and nothing
else does:

```js
const repairOptions = {
	...options,
	maxRetries: Math.min(options.maxRetries, 1),
	maxTurns: healRepairTurnBudget(options.maxTurns),
	// Phase 236: mark this bag so applyCompletionCap (model-client.mjs) injects the
	// honored max_tokens:completionReserve wire cap ONLY on heal turns. The main loop
	// / staged path carry the base options (no marker) and stay uncapped — the cap at
	// completionReserve (4096 for qwen3.6) starves legitimate generation on thinking
	// models (probe 2026-06-20: 4095 reasoning toks + 0 answer chars). On heal turns
	// the cap is desired: it fast-fails a reasoning runaway via finish_reason:length
	// (phase 231/234).
	completionCapMode: 'heal',
};
```

The rest of the heal callback (including the phase-235 `clear()` and the
`draftNonEmpty` merge) is unchanged.

## Edge cases & regression guards

- **HEAL cap byte-identical (phases 234/235).** Heal turns still send
  `max_tokens: completionReserve` (same field, same value), because
  `repairOptions` carries `completionCapMode: 'heal'`. The phase-231 runaway
  fast-fail (`finish_reason: length` + zero answer → `reasoning_runaway`) and the
  phase-234 dogfood heal fast-fail are **unaffected**. Phase 235's heal-turn
  `clear()` is untouched.
- **Caller override still wins on heal.** When a heal request body already pins
  `max_tokens` or `max_completion_tokens`, no cap is injected (guard preserved,
  now after the marker gate). No caller sets either today (grep: zero), so this is
  forward-proofing — but the test still asserts it.
- **Main loop uncapped.** Base `options` has no `completionCapMode` → early return
  → no `max_tokens`. Exactly the pre-234 known-good wire shape.
- **Staged uncapped.** `runStagedPrompt` flows the base `options` through the main
  `createChatCompletion` path → no marker → uncapped. **Correct:** staged
  generation needs room just like the main loop; the only path that wants the
  tight cap is heal. (Phase 234 had inadvertently capped staged too.)
- **Non-thinking models (gemma / gpt-oss).** They never hit the SUM-on-reasoning
  starvation, and the main loop being uncapped for them is also fine / known-good
  (it was uncapped pre-234). On heal turns they still get the marker-gated cap;
  `max_tokens` is a standard OpenAI field honored in streaming and non-streaming
  alike, so the heal fast-fail still works for them. No harm.
- **`completionReserve` unset / `''` / `0` / non-integer → no cap.** The
  positive-integer guard is preserved (now after the marker gate). A heal-marked
  bag without a usable `completionReserve` still injects nothing — no
  `max_tokens: 0` / `max_tokens: undefined` footgun.
- **Composition intact.** `applyRequestParameters` (still sends
  `max_thinking_tokens`) and `applyPromptCacheControl` are byte-identical; the
  three injectors touch disjoint keys; `buildChatRequestBody`'s nesting is
  unchanged. The existing thinking-token and Anthropic cache tests pass unchanged.
- **Streaming / non-streaming.** Body is still built once in `createChatCompletion`
  and carried into both wires; no per-wire cap handling. Unchanged from phase 234.

## Tests (`test/model-client.test.mjs`)

The phase-234 `describe('completion cap request shaping', …)` block (lines
~96-210) asserts the cap behavior. Because the cap is now heal-scoped, the tests
that assert the cap **is present** must pass `completionCapMode: 'heal'` in their
options bag; the tests that assert **no cap** / caller-override stay as-is and gain
new sibling coverage for the main-loop (no-marker) case.

**Phase-234 tests to UPDATE (add `completionCapMode: 'heal'` so the cap still
asserts — preserve coverage, do not delete):**

- [ ] `'adds max_tokens when completionReserve is a positive integer'`
  (line ~100) → options `{ completionReserve: 4096, completionCapMode: 'heal' }`;
  still asserts `request.max_tokens === 4096` and input body unmutated.
- [ ] `'value equals options.completionReserve, not a hardcoded constant'`
  (line ~109) → options `{ completionReserve: 2048, completionCapMode: 'heal' }`;
  still asserts `=== 2048`.
- [ ] `'coexists with max_thinking_tokens'` (line ~171) → add
  `completionCapMode: 'heal'`; still asserts both `max_tokens === 4096` and
  `max_thinking_tokens === 512`.
- [ ] `'coexists with cache_control (Anthropic remote model)'` (line ~181) → add
  `completionCapMode: 'heal'`; still asserts `max_tokens === 8192` and
  `cache_control`.
- [ ] `'composition-order invariant…'` (line ~195) → add
  `completionCapMode: 'heal'`; still asserts all three keys.

**Phase-234 tests that stay UNCHANGED (they already assert no cap or
caller-override; with a missing marker they'd now ALSO be no-cap, so keep them as
explicit no-cap evidence — but rewrite the two caller-override ones to carry the
heal marker so they still prove "override wins even on heal"):**

- [ ] `'does not add max_tokens when caller body already has max_tokens'`
  (line ~118) → add `completionCapMode: 'heal'` so it proves override wins **on a
  heal turn** (the only path that would otherwise inject); still asserts
  `max_tokens === 99`.
- [ ] `'does not add max_tokens when caller body already has max_completion_tokens'`
  (line ~127) → add `completionCapMode: 'heal'`; still asserts no `max_tokens`,
  `max_completion_tokens === 200`.
- [ ] `'preserves both caller override keys when present together'` (line ~161) →
  add `completionCapMode: 'heal'`; still asserts both override keys preserved.
- [ ] `'does not add max_tokens when completionReserve is unset'` (line ~137),
  `'… is 0 …'` (line ~143), `'… is negative …'` (line ~152) — these omit the marker
  AND lack a usable reserve. Keep them; they double-guard (no marker AND no usable
  reserve). Optionally add `completionCapMode: 'heal'` to the 0/negative ones so
  they specifically prove the positive-integer guard still bites on a heal turn —
  do this for the 0 and negative cases (the empty-completion footgun must stay
  guarded on the heal path).

**New tests (the phase-236 regression fix — main-loop / staged uncapped):**

- [ ] **main-loop options (no `completionCapMode`) → NO `max_tokens`** —
  `buildChatRequestBody({ completionReserve: 4096 }, { messages, model })` →
  `Object.hasOwn(request, 'max_tokens') === false`. This is the regression guard:
  the main loop must be uncapped even with a positive `completionReserve`.
- [ ] **explicit non-heal mode → NO `max_tokens`** —
  `buildChatRequestBody({ completionReserve: 4096, completionCapMode: 'main' },
  { messages, model })` → no `max_tokens` (only `'heal'` triggers the cap).
- [ ] **heal mode + positive reserve → cap present** (covered by the updated
  positive-integer test above, but assert explicitly in a focused test if clearer):
  `{ completionReserve: 4096, completionCapMode: 'heal' }` → `max_tokens === 4096`.
- [ ] **heal mode coexists with max_thinking_tokens for the MAIN-loop param**
  sanity: a no-marker bag with `maxThinkingTokens` still gets
  `max_thinking_tokens` but NO `max_tokens` (proves `applyRequestParameters` is
  independent of the marker).

**Heal-path plumbing assertion (`test/healing.test.mjs` or wherever the heal
repairOptions construction is reachable):**

- [ ] Confirm the heal path carries the marker. If `repairOptions` is not directly
  unit-testable, add a focused assertion that the constructed heal options bag sets
  `completionCapMode: 'heal'` (e.g. via an exported helper or by asserting the
  request body shape through the existing fake-model-server heal harness in
  `test/app.test.mjs`). Prefer the cheapest assertion that proves the marker is
  set on heal and absent on the main call. If a clean seam doesn't exist, document
  that the model-client unit tests above cover the gate and the run-pipeline change
  is a one-line marker on the single `repairOptions` site (low risk), and rely on
  the existing heal app-tests to exercise the heal path end-to-end.

**Existing-behavior confirmations:**

- [ ] The phase-234 dogfood heal fast-fail (`finish_reason: length` →
  `reasoning_runaway`) is unaffected — heal still sends the cap. (Covered by the
  unchanged `test/app.test.mjs` heal tests and `test/healing.test.mjs`
  `isReasoningRunaway` tests; confirm they pass unchanged.)
- [ ] The streaming thinking-token test and the Anthropic cache tests pass
  unchanged (the marker gate does not touch `max_thinking_tokens` or
  `cache_control`).

## Work items (Required Loop)

- [x] Gate `applyCompletionCap` on `options.completionCapMode === 'heal'`
  (`src/model-client.mjs`); add the marker `completionCapMode: 'heal'` to
  `repairOptions` (`src/run-pipeline.mjs` ~2575). `buildChatRequestBody`,
  `applyRequestParameters`, `applyPromptCacheControl` byte-identical.
- [x] Update the phase-234 cap tests to carry the heal marker where they assert the
  cap is present (preserve coverage); add the main-loop / non-heal **no-cap**
  regression tests; add the heal-path marker assertion
  (`test/model-client.test.mjs`, plus heal-path plumbing per the Tests section).
- [x] `npm run format` (globally-installed Biome; do not add it as a dependency).
- [x] Run tests (`node --test` / `npm test`).
- [x] `npm run check` — requires `package.json` version == max roadmap phase, so
  bump `0.0.235` → `0.0.236` first.
- [x] `process/decisions.jsonl`: record the cap-scoping decision — the honored
  `max_tokens: completionReserve` cap is now **HEAL-ONLY** (marker
  `completionCapMode: 'heal'` on `repairOptions`); main loop / staged revert to the
  known-good pre-234 uncapped wire shape. **Correct phase 234's "apply to ALL
  requests" assumption** — it is NOT universally correct for thinking models. Cite
  the 2026-06-20 generation probe (`max_tokens: 4096` → 4095 reasoning toks + 0
  answer chars / `finish_reason: length`; uncapped → 10610 completion toks + a
  complete 11378-char two-file answer). Cross-reference phases 231/234/235.
- [x] `process/failures.jsonl`: short entry — phase 234 introduced a main-loop
  truncation regression by applying the heal cap to all requests; caught by
  pre-audit probing **before** it broke the ambitious multi-file dogfood (the
  phase-234 dogfood used tiny files and never reached 4096). Fix: scope the cap to
  heal. Cross-ref phase 234; do not duplicate the runaway-detection symptom text.
- [x] `blog/236-scope-completion-cap-to-heal.md`: theme "The cap that helped heal
  and starved generation" — the two probes side by side (heal fast-fail vs main-loop
  total truncation), why a SUM cap on a thinking model is fine for heal but fatal
  for generation, and why heal-scoping (revert main to known-good uncapped) beats
  raising `completionReserve` or a generous main cap.
- [x] `roadmap.md`: append `- [x] 236 Scope the Honored Completion Cap to HEAL
  Turns Only (Un-Starve Main Generation)`.
- [x] `package.json`: bump `0.0.235` → `0.0.236`.
- [x] `NEXT.md`: update "Current frontier" to phase 236. In the "Completion cap
  tightness on thinking models (follow-up to phase 234)" candidate: this phase
  resolves the **main-loop** half (main/staged are now uncapped, so the only place
  the SUM cap applies is heal, where it is wanted). **Remove** the main-loop
  truncation concern; **keep** the genuinely-residual heal-specific note (whether
  `completionReserve: 4096` is too tight for a large multi-file *heal* answer — a
  legit heal that needs >4096 reasoning+answer tokens would still hit
  `finish_reason: length` and be misread as runaway by the phase-231 predicate;
  watch in dogfood; if observed, raise `completionReserve` for the profile or add a
  token-count heuristic to the predicate, or adopt design (C) for the main loop).
- [x] Commit (small, single phase).

## Must NOT change (regression guard)

- The HEAL wire cap (phases 234/235): heal turns still send
  `max_tokens: completionReserve` — same field, same value. Phase-231 runaway
  detection and the phase-234 dogfood heal fast-fail are byte-identical in behavior.
- `applyRequestParameters` — byte-identical; the existing `'passes opt-in
  thinking-token caps'` streaming test must pass unchanged.
- `applyPromptCacheControl` and the Anthropic cache tests — unchanged; the marker
  gate touches only the `max_tokens` injection path (disjoint key).
- `buildChatRequestBody` composition — unchanged
  (`applyPromptCacheControl(applyCompletionCap(applyRequestParameters(...)))`).
- The streaming/non-streaming branch logic in `createChatCompletion` — body still
  built once; no per-wire cap handling.
- Phase-235's heal-turn `registry.proposalDraft?.clear()` and the `draftNonEmpty`
  merge — unchanged; only `completionCapMode: 'heal'` is added to `repairOptions`.
- No new CLI flag, no new option exposed to users, no new constant — the marker is
  an internal options-bag flag set only at the single `repairOptions` site; the cap
  value still reuses `options.completionReserve`.
- Non-profile callers and the main loop (tests/paths without the heal marker) —
  must see NO `max_tokens` added.
