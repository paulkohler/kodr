# Phase 234: The Cap the Model Ignored, and the One It Didn't

Phase 231 gave kodr the ability to detect a reasoning-token runaway and fail fast
with an accurate diagnostic. The artifact that drove it — a qwen3.6 heal turn that
produced 21,693 reasoning tokens against a `max_thinking_tokens: 4096` request —
already named the next question: was the cap even being honored?

It wasn't. But finding out which cap *was* honored turned out to matter more than
finding the unhonorable one.

## The probe

The question was simple: which wire parameter does LM Studio actually honor for
qwen3.6-35b-a3b? Six variants, one parameter changed at a time, same multi-step
arithmetic prompt, temp 0, non-streaming wire.

| param sent | honored? | finish_reason | reasoning tokens | latency |
|---|---|---|---|---|
| `max_thinking_tokens: 60` | IGNORED | stop | 1425 | ~19s |
| `reasoning_effort: "low"` | IGNORED | stop | 1425 | ~19s |
| nested `reasoning: { max_tokens: 60 }` | IGNORED | stop | 1425 | ~19s |
| `max_tokens: 60` | **HONORED** | length | 59 total | ~900ms |
| `max_completion_tokens: 60` | **HONORED** | length | caps SUM | ~750ms |
| baseline (no cap) | — | stop | 1425 + 176 = 1601 | ~20s |

The result was unambiguous. The three thinking-specific parameters — the ones you
would reach for if you wanted to limit reasoning — are all silently ignored. The two
general-purpose OpenAI completion caps both fire, and they fire fast (~900ms vs
~20s). The existing `max_thinking_tokens: 4096` that kodr has been sending on every
heal request is a no-op for qwen3.6.

## The correction

The NEXT.md candidate for this phase was framed as "reserve answer room": set the
cap to `contextWindow - promptTokens - answerBudget` so the model cannot exhaust the
window with reasoning. The probe corrects that framing.

`max_tokens` caps the **sum** of reasoning and answer tokens together, not reasoning
alone. Setting `max_tokens: 4096` on a runaway turn means the model hits the cap and
returns `finish_reason: length` with zero answer tokens — the same signal as the
unmitigated runaway, just at 4096 tokens instead of 32768. The cap does not guarantee
answer room. A model that wants to reason will use all of it on reasoning.

What the honored cap *does* deliver is different: a runaway that previously ground
the full context window over 200–330 seconds now returns `finish_reason: length` in
under a second. Phase 231's `isReasoningRunaway` predicate — which already fires on
`finish_reason: length` plus zero answer tokens — catches it immediately. One doomed
turn at ~900ms instead of two doomed turns at ~670 seconds.

That is the deliverable: fast-fail, not answer-reservation.

## The fix

A small pure function `applyCompletionCap` added to `src/model-client.mjs`, composed
into the existing `buildChatRequestBody` pipeline alongside `applyRequestParameters`
and `applyPromptCacheControl`. The three injectors touch disjoint keys
(`max_thinking_tokens`, `max_tokens`, `cache_control`) so composition order is
immaterial — but the nesting is kept explicit and stable.

The cap value is `options.completionReserve`, which is already the budget kodr
reserves for completions in context-packing. qwen3.6 gets 4096, ollama profiles get
2048, openrouter gets 8192. No new constant, no new option — the value already exists
and already flows through to every request via the options bag.

The guard is `Number.isInteger(cap) && cap > 0`. This matters: `max_tokens: 0` would
be catastrophic (zero-length completions). Any non-profile caller — raw
`createChatCompletion` calls in tests, `listModels` paths — omits `completionReserve`
entirely, so `undefined` and `0` and `''` all produce no cap at all.

Caller override wins: if the request body already pins `max_tokens` or
`max_completion_tokens`, the function returns it untouched. No existing caller sets
either (grep confirmed zero occurrences in `src/`), so this is forward-proofing.

The existing `max_thinking_tokens` injection stays. It is harmless for qwen3.6
(ignored) and may be honored by other thinking models. The two fields coexist on
disjoint keys.

## What the probe numbers tell you about normal turns

The probe's baseline (no cap, finish_reason: stop) used 1601 total tokens: 1425
reasoning, 176 answer. A `completionReserve` of 4096 leaves 2.5x headroom above that
natural usage. The cap is completely invisible to normal heal turns — they stop on
their own at `finish_reason: stop` well within the limit.

It only bites when the model reasons itself past ~4096 tokens without stopping. That
is exactly the runaway profile, and exactly what the cap is meant to hit.

## Why no streaming special-case

`max_tokens` is a standard top-level OpenAI chat-completion field. `createChatCompletion`
builds the request body once via `buildChatRequestBody` and then either sends it
directly (wireNoStream branch) or spreads it into the streaming options alongside
`stream: true`. The cap travels into both wires with no per-branch handling. A runaway
on a streaming model hits `finish_reason: length` fast in exactly the same way.

## Tests: 1860 → 1869

Nine new pure-function cases in `test/model-client.test.mjs` under
`describe('completion cap request shaping')`:

- `max_tokens` added when `completionReserve` is a positive integer; input body not mutated.
- Value equals `options.completionReserve` (not a hardcoded constant).
- Not added when caller body already has `max_tokens` (override preserved).
- Not added when caller body already has `max_completion_tokens` (both honored caps respected).
- Not added when `completionReserve` is unset.
- Not added when `completionReserve` is 0 (empty-completion footgun guard).
- Coexists with `max_thinking_tokens` (disjoint keys, both present).
- Coexists with `cache_control` (Anthropic remote model, all three injectors fire).
- Composition-order invariant: all three injectors produce disjoint keys without clobbering.

The existing `'passes opt-in thinking-token caps through request bodies'` streaming
test passes unchanged — it omits `completionReserve`, so no `max_tokens` is added.
All 1860 pre-existing tests pass unchanged.
