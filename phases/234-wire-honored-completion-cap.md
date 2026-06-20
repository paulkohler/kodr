# Phase 234 — Wire a Honored `max_tokens` Completion Cap (Fast-Fail Reasoning Runaway)

## Motivation (the cap the model ignored, and the one it didn't)

Phase 231 ships **detection** of reasoning runaway in the heal loop: when qwen3.6
(wireNoStream) returns `finish_reason: "length"` with zero answer tokens, the loop
breaks immediately with `stopReason: 'reasoning_runaway'`. But there is no
**mitigation** — kodr sends `max_thinking_tokens: 4096` on every request and LM
Studio / qwen3.6 *ignores it*, so a runaway still grinds tens of thousands of
reasoning tokens to fill the 32K window (~200–330s) before the honored stop
condition (window exhaustion) fires. The `final-audit/blog-platform` artifact
(2026-06-20) recorded **21,693 reasoning tokens** against a `max_thinking_tokens:
4096` request.

`NEXT.md`'s open candidate ("Bound the reasoning budget on heal turns") asked
which wire param LM Studio actually honors for qwen3.6, and proposed reserving
answer room by setting that param to `contextWindow - promptTokens - answerBudget`.
A controlled live probe (below) answers the question and **corrects** that premise.

## Ground-truth probe (qwen/qwen3.6-35b-a3b, LM Studio, temp 0, non-streaming wire)

System "think step by step", a multi-step arithmetic prompt, varying ONE cap
param at a time and reading `usage` + `finish_reason`:

| param sent | honored? | finish_reason | reasoning toks | answer | latency |
|---|---|---|---|---|---|
| `max_thinking_tokens: 60` | **IGNORED** | stop | 1425 | full 486 chars | ~19s |
| `reasoning_effort: "low"` | **IGNORED** | stop | (identical full output) | full | ~19s |
| nested `reasoning: { max_tokens: 60 }` | **IGNORED** | stop | (identical full output) | full | ~19s |
| `max_tokens: 60` | **HONORED** | length | 59 | content_len 0 | ~900ms |
| `max_completion_tokens: 60` | **HONORED** | length | (caps reasoning+answer SUM) | — | ~750ms |
| baseline (no cap) | — | stop | 1425 | 176 (total 1601) | ~20s |

**Key implications:**

1. There is **NO param that caps reasoning ALONE** for qwen3.6.
   `max_thinking_tokens` / `reasoning_effort` / nested `reasoning.max_tokens` are
   all ignored. `max_thinking_tokens: 4096` (what kodr currently sends) does
   *nothing* for this model.
2. The only honored caps are `max_tokens` and `max_completion_tokens`, and they
   bound the **SUM** (reasoning + answer combined), not reasoning alone.
3. Therefore `NEXT.md`'s "reserve answer room by setting the cap so the model
   cannot consume the window with reasoning" is **partly WRONG**: capping
   `max_tokens` does NOT reserve answer room — a runaway can still spend the entire
   cap on reasoning and emit `finish_reason: length` with zero answer.

**What the honored cap DOES buy (and what this phase delivers):** when reasoning
runs away, the model hits the cap in ~1s and returns `finish_reason: length` —
which phase-231's `isReasoningRunaway` predicate (`finishReasons[-1] === 'length'`
+ zero answer tokens) **already catches** → an instant fast-fail instead of LM
Studio grinding to fill the 32K window over 200–330s. Normal heal answers fit
comfortably under the cap: the probe's full reasoning+answer was 1601 tokens, well
under qwen3.6's `completionReserve` of 4096. So a `completionReserve`-sized
`max_tokens` is invisible to healthy turns and converts a multi-minute runaway
into a sub-second one.

## Root cause

`applyRequestParameters` (`src/model-client.mjs` ~158-170) is the only wire-param
injector and it adds **only** `max_thinking_tokens` — a param the target model
ignores. No honored cap (`max_tokens` / `max_completion_tokens`) is ever set
anywhere in `src/` (grep confirmed: zero wire-field occurrences; only the loop
budget `options.maxTokens` and a comment at `model-client.mjs:87`). So a runaway
has no honored ceiling and must exhaust the full context window before any stop
condition fires.

## Heal path reaches the cap (verified — no plumbing needed)

Confirmed end-to-end that `options.completionReserve` reaches the heal request, so
a wire cap derived from it will apply on heal turns:

- `src/run-pipeline.mjs:2575` `repairOptions = { ...options, ... }` spreads the
  full options bag (carrying `completionReserve`, set by
  `applyModelProfileDefaults` at `model-profiles.mjs:162-167`).
- `src/run-pipeline.mjs:2590-2605` the `repairTurn` callback calls
  `completeWithToolCalls(repairOptions, …)` (tool channel, the qwen3.6 path) or
  `completeWithContinuations(repairOptions, …)` (text channel).
- `src/tool-calls.mjs:397` `createChatCompletion(options, requestBody)` and
  `src/completion.mjs:50` `createChatCompletion(options, …)` both forward the
  options bag.
- `src/model-client.mjs:82-83` `createChatCompletion` → `buildChatRequestBody(options, body)`
  → `applyRequestParameters(options, body)`.

So `completionReserve` is present on `options` at the injection point on heal
turns. It is equally present on **all other request types** (main loop, staged) —
they all flow through the same `createChatCompletion` → `buildChatRequestBody`
path — so applying the cap everywhere is a one-line correctness win, not a
heal-only special case. The locally-built `requestBody` in `completeWithToolCalls`
(`tool-calls.mjs` ~380-394) and `completeWithContinuations`
(`completion.mjs` ~52-59) set only `messages` / `model` / `temperature` /
optional `tools` — neither sets `max_tokens` or `max_completion_tokens`, so the
caller-override guard is a no-op there and the cap applies cleanly.

## The fix

A small pure sibling function `applyCompletionCap`, composed into
`buildChatRequestBody` alongside the existing param/cache injectors. Keep
`applyRequestParameters` (still sends `max_thinking_tokens` — harmless, and may be
honored by gemma/gpt-oss) byte-identical so its existing test passes unchanged.

### 1. New `applyCompletionCap` (add near `applyRequestParameters`, `src/model-client.mjs` ~158)

```js
// Phase 234: inject a HONORED wire-level completion cap. Probe (2026-06-20)
// against qwen3.6 showed max_thinking_tokens / reasoning_effort / nested
// reasoning.max_tokens are ALL ignored; only max_tokens / max_completion_tokens
// are honored, and they bound the SUM (reasoning + answer). The cap does not
// reserve answer room (a runaway can still spend it all on reasoning) — its value
// is that a runaway hits it in ~1s and returns finish_reason:length, which the
// phase-231 heal runaway detector already fast-fails on, instead of grinding the
// full context window over 200-330s. Healthy heal answers (~1601 tokens in the
// probe) fit well under completionReserve, so the cap is invisible to them.
function applyCompletionCap(options, body) {
	const cap = options.completionReserve;
	// Only a positive integer is a usable cap. '', undefined, 0, non-integers →
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

### 2. Compose into `buildChatRequestBody` (`src/model-client.mjs` ~151-156)

Preserve the existing composition order (`applyRequestParameters` innermost, then
`applyPromptCacheControl`); insert `applyCompletionCap` between them so the cap is
present before cache-control runs (order is immaterial — the three injectors touch
disjoint keys — but keep it explicit and stable):

```js
export function buildChatRequestBody(options, body) {
	return applyPromptCacheControl(
		options,
		applyCompletionCap(options, applyRequestParameters(options, body)),
	);
}
```

`applyRequestParameters` and `applyPromptCacheControl` are unchanged.

## Why no streaming special-case is needed

`max_tokens` is a standard top-level OpenAI chat-completion field, honored
identically in streaming and non-streaming mode. `createChatCompletion` builds the
body **once** via `buildChatRequestBody` (`model-client.mjs:83`) and then either
sends it as-is (wireNoStream branch) or spreads it into the SSE `streamOpts.body`
(adding `stream`/`stream_options`) — so the cap is carried into both wires with no
branch-specific handling. The honored streaming cap behaves the same for gemma
(streaming) as for qwen3.6 (non-streaming): a runaway hits `finish_reason: length`
fast in both. No special-casing.

## Edge cases & decisions

- **Caller override wins.** `body` already has `max_tokens` *or*
  `max_completion_tokens` → no injection. No existing caller sets either (grep:
  zero), so this is forward-proofing.
- **`completionReserve` unset / `''` / `undefined` / `0` / non-integer → no cap.**
  Guards every non-profile caller (raw `createChatCompletion`/`buildChatRequestBody`
  tests, `listModels`-style paths) against an accidental `max_tokens: undefined` or
  `max_tokens: 0` (a zero would be catastrophic — empty completions). `Number.isInteger
  && > 0` is the exact gate.
- **Cap value = `options.completionReserve`** (qwen3.6 = 4096; ollama 2048;
  openrouter 8192). Internally consistent: it is already the budget kodr reserves
  for completion in context-packing (`context-packer.mjs:249`,
  `sessionContextCharsForProfile`). No new constant, no new option.
- **`max_thinking_tokens` still sent.** Harmless for qwen3.6 (ignored); may be
  honored by other thinking models. Coexists with `max_tokens` (disjoint keys).
- **Composition order preserved.** `cache_control` injection still runs over the
  capped body; the three injectors mutate disjoint keys so output is order-
  independent, but the nesting is kept explicit.
- **Streaming.** Covered above — no special-casing.
- **Does NOT reserve answer room.** Explicitly NOT claimed. The deliverable is
  fast-fail, not answer-preservation. (Decisions entry records this correction to
  the NEXT.md premise.)

## Tests (`test/model-client.test.mjs`)

Add a `describe('completion cap request shaping', …)` block. `buildChatRequestBody`
is already imported. Pure-function assertions (no server needed) plus the existing
streaming param test as the wire-level coexistence check:

- [x] **max_tokens added when completionReserve is a positive integer** —
  `buildChatRequestBody({ completionReserve: 4096 }, { messages, model })`
  → `request.max_tokens === 4096`; input `body` not mutated
  (`Object.hasOwn(body, 'max_tokens') === false`).
- [x] **value equals completionReserve** — assert `=== options.completionReserve`,
  not a hardcoded constant.
- [x] **NOT added when caller body already has `max_tokens`** —
  `buildChatRequestBody({ completionReserve: 4096 }, { messages, model, max_tokens: 99 })`
  → `request.max_tokens === 99` (override preserved).
- [x] **NOT added when caller body already has `max_completion_tokens`** —
  no `max_tokens` injected; `max_completion_tokens` preserved.
- [x] **NOT added when completionReserve unset** — `buildChatRequestBody({}, body)`
  → `Object.hasOwn(request, 'max_tokens') === false`.
- [x] **NOT added when completionReserve is 0** — explicit zero → no cap (guards the
  empty-completion footgun).
- [x] **coexists with max_thinking_tokens** —
  `buildChatRequestBody({ completionReserve: 4096, maxThinkingTokens: 512 }, body)`
  → both `max_tokens === 4096` AND `max_thinking_tokens === 512` present.
- [x] **coexists with cache_control** —
  `buildChatRequestBody({ provider: 'openrouter', promptCache: 'auto',
  completionReserve: 8192 }, { messages, model: 'anthropic/claude-sonnet-4.5' })`
  → both `max_tokens === 8192` AND `cache_control: { type: 'ephemeral' }` present.
- [x] **composition-order / disjoint-keys invariant** — a single
  `buildChatRequestBody` with `completionReserve` + `maxThinkingTokens` + Anthropic
  cache produces all three keys in one object (proves the three injectors compose
  without clobbering each other).
- [x] Confirm the existing `'passes opt-in thinking-token caps through request
  bodies'` streaming test still passes UNCHANGED (it omits `completionReserve`, so
  no `max_tokens` is added — assert nothing new there).

## Work items (Required Loop)

- [x] Add `applyCompletionCap` and compose it into `buildChatRequestBody`
  (`src/model-client.mjs`). `applyRequestParameters` / `applyPromptCacheControl`
  unchanged.
- [x] Add the `describe('completion cap request shaping', …)` tests above to
  `test/model-client.test.mjs`; confirm the existing thinking-token + cache tests
  pass unchanged.
- [x] `npm run format` (globally-installed Biome).
- [x] Run tests (`node --test` / `npm test`).
- [x] `npm run check` — requires `package.json` version == max roadmap phase, so
  bump `0.0.233` → `0.0.234` first.
- [x] `process/decisions.jsonl`: record the honored-cap decision — cite the
  2026-06-20 probe table (max_thinking_tokens/reasoning_effort/nested reasoning
  IGNORED; max_tokens/max_completion_tokens HONORED, capping the SUM); state the
  chosen field (`max_tokens`), cap value (`completionReserve`), and the **correction
  to the NEXT.md premise** (the cap does NOT reserve answer room; its value is
  fast-fail via phase-231 detection). Cross-reference phase 231 and
  `final-audit/blog-platform` (21,693 reasoning tokens).
- [x] `process/failures.jsonl`: **no new entry** — the underlying runaway is already
  recorded (phase 231 / final-audit). Note this explicitly; do not duplicate.
- [x] `blog/234-wire-honored-completion-cap.md`: theme "The cap the model ignored,
  and the one it didn't" — the probe story, why `max_thinking_tokens` is a no-op for
  qwen3.6, why a SUM cap still helps (fast-fail, not answer-reservation), and the
  NEXT.md premise correction.
- [x] `roadmap.md`: append `- [x] 234 Wire a Honored max_tokens Completion Cap
  (Fast-Fail Reasoning Runaway)`.
- [x] `package.json`: bump `0.0.233` → `0.0.234`.
- [x] `NEXT.md`: update the "Bound the reasoning budget on heal turns" candidate —
  **remove the now-WRONG "reserve answer room by setting that param to
  contextWindow - promptTokens - answerBudget" mitigation framing**; replace with
  the corrected understanding (only `max_tokens`/`max_completion_tokens` are
  honored and they cap the SUM, so the honored cap converts runaway into a
  sub-second `finish_reason:length` fast-fail rather than reserving answer room —
  shipped in phase 234). Keep ONE residual open question: whether a 4096
  `completionReserve` cap is too tight for large multi-file heal answers on thinking
  models (a legitimate answer that needs >4096 reasoning+answer tokens would be
  truncated to `finish_reason:length` and misread as runaway) — flag as the next
  thing to watch in dogfood. Also update the "Current frontier" note to phase 234.
- [x] Commit (small, single phase).

## Must NOT change (regression guard)

- `applyRequestParameters` — byte-identical; the existing `'passes opt-in
  thinking-token caps'` test must pass unchanged.
- `applyPromptCacheControl` and the Anthropic cache tests — unchanged; the new cap
  touches a disjoint key (`max_tokens`) and must not perturb `cache_control`.
- The streaming/non-streaming branch logic in `createChatCompletion` — the body is
  still built once; no per-wire cap handling.
- No new CLI flag, no new option, no new constant — the cap reuses the existing
  resolved `options.completionReserve`.
- Phase-231 heal runaway detection — unchanged; this phase makes its `length`
  trigger fire faster, it does not alter the predicate.
- Non-profile callers (tests/paths without `completionReserve`) — must see NO
  `max_tokens` added (the `Number.isInteger && > 0` guard).
