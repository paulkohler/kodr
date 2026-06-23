# Phase 260 — Heal-Loop Reasoning-Runaway Fix (Force Output on the Repair Turn)

## Problem

When a test fails after a `kodr run`, the heal turn frequently burns its entire
token budget on chain-of-thought and emits **0 content chars** with
`finish_reason: length`. The loop classifies this `reasoning_runaway` and
fast-fails, so a trivial fix (one wrong column name, one bad import) never lands.

Recent dogfood: "healing loop fired (reasoning_runaway), exhausted 7,581
reasoning tokens against a 46,590-token context, emitted 0 content chars before
hitting context-length cutoff."

Phases 231/234/236/240/244 built the **detection and fast-fail** machinery. They
correctly *notice* the runaway and stop wasting time. None of them make the heal
turn actually **produce a repair** — the model still spends 100% of its honored
budget on reasoning. This phase closes that gap: force the repair turn to emit
output.

---

## 1. Diagnosis (mechanical, with file:line)

### 1a. What the heal turn sends today

`runHealingIfNeeded` (`src/run-pipeline.mjs:2680-2694`) builds `repairOptions`
with `completionCapMode: 'heal'`. The repair callback then calls
`completeWithToolCalls(repairOptions, …)` (`src/run-pipeline.mjs:2728`), which
funnels every turn through `createChatCompletion(options, body)`
(`src/tool-calls.mjs:421`) → `buildChatRequestBody`
(`src/model-client.mjs:154-159`).

`buildChatRequestBody` applies two relevant transforms:

1. `applyCompletionCap` (`src/model-client.mjs:177-220`): because
   `completionCapMode === 'heal'`, it injects `max_tokens: completionReserve`.
   For the qwen3.6 profile `completionReserve = 4096`
   (`src/model-profiles.mjs:42,59`). So the heal request carries
   **`max_tokens: 4096`**.
2. `applyRequestParameters` (`src/model-client.mjs:222-234`): injects
   `max_thinking_tokens: options.maxThinkingTokens`. For qwen3.6 the profile sets
   `maxThinkingTokens: 16384` (`src/model-profiles.mjs:49`). So the request also
   carries **`max_thinking_tokens: 16384`**.

### 1b. Why that produces zero output

Per the probe documented at `src/model-client.mjs:162-176` and the profile
comment at `src/model-profiles.mjs:46-49`:

> LM Studio ignores `max_thinking_tokens` for qwen3.6 (probe 2026-06-20: only
> `max_tokens` is honored, bounding reasoning+answer **together**).

So on a heal turn:
- `max_thinking_tokens: 16384` is **silently ignored**.
- `max_tokens: 4096` is the *only* honored ceiling, and it bounds
  `reasoning_tokens + answer_tokens` as a single sum.
- The model is free to spend all 4096 on `<think>`, hit `finish_reason: length`
  with the answer never started → **0 content chars**.

`isReasoningRunaway` (`src/healing.mjs:154-171`) then matches: empty text +
`finish_reason: length` + `completionTokens >= cap * 0.95` (proximity guard,
phase 244) → `stopReason = 'reasoning_runaway'`, loop aborts
(`src/healing.mjs:386-418`). The repair never happens; `run-summary.mjs:131-148`
renders the "thinking budget is not being honored" message.

### 1c. Why the prior "capped retry" did not help (the NEXT.md note)

The staged path's analogue (`staged-retry`, floor 8192 —
`src/model-client.mjs:189-200`, used at `src/run-pipeline.mjs:1998-2016`) shows
the identical disease at a larger cap: NEXT.md "Capped-retry zero-output on
thinking models" records that with `max_tokens: 8192` the model *still* burns all
8192 on reasoning and emits 0 chars. **Raising the sum-cap cannot fix this** —
because the cap bounds the sum, a larger cap just buys more reasoning room. The
model's reasoning expands to fill whatever sum-budget it is given.

### 1d. The real root cause (one sentence)

The heal turn shares **one honored budget** between reasoning and output, and the
thinking-token cap that *should* carve out an output reserve is **not honored** by
LM Studio for this model. There is no honored knob today that guarantees the
answer gets any tokens.

---

## 2. Proposed fix

Two complementary levers, applied in order. The heal turn is small (fix one
error) and does not need deep reasoning, so suppressing reasoning is the
principled move — not buying more of it.

### Primary: disable thinking on heal turns (probe-gated)

Add a heal-turn request shape that suppresses reasoning so the entire honored
`max_tokens` budget is available for the answer. The mechanism must be verified
against the real LM Studio + qwen3.6 before the phase is marked complete
(AGENTS.md security/behaviour rule: probe before relying on a wire param).

Candidate mechanisms to probe (in `src/model-client.mjs`, mirroring how
`max_thinking_tokens` is injected at `applyRequestParameters`):

1. `chat_template_kwargs: { enable_thinking: false }` — the documented qwen3
   template switch; LM Studio passes `chat_template_kwargs` through to the Jinja
   template. Most likely to be honored.
2. `reasoning: { effort: "low" }` / `reasoning_effort: "low"` — already noted
   ignored for qwen3.6 (`src/model-client.mjs:162`), so deprioritise.
3. Appending `/no_think` to the final user (repair) message — qwen3 soft switch;
   prompt-level, always available even if no wire param is honored.

**Decision rule:** curl-probe each candidate against
`http://localhost:1234/v1/chat/completions` with the qwen3.6 model and a trivial
"reply with the word DONE" prompt at `max_tokens: 256`. Whichever produces
`reasoning_tokens: 0` (or a non-empty `content`) is the mechanism we wire. Record
the probe verbatim in `process/decisions.jsonl`. If a wire param works, prefer
it; `/no_think` is the prompt-level fallback that needs no server support.

### Secondary / fallback: force-output retry with a tight cap

If thinking cannot be disabled at all (every probe fails), fall back to forcing
output by structure rather than budget:

- On a detected heal `reasoning_runaway`, issue **one** retry with a
  deliberately tight `max_tokens` (e.g. 2048) **and** a `/no_think`-prefixed
  prompt, so the model is pushed to emit before exhausting the budget. This is
  strictly better than today (today the runaway just aborts), and harmless if the
  primary already works.

This phase wires the **detect-then-retry-with-thinking-suppressed** loop so it is
correct regardless of which suppression mechanism the probe blesses: the retry
swaps in the suppressed-reasoning request shape (wire param if honored, else
`/no_think` prompt + tight cap).

### Why not "just lower max_tokens"

Lowering the shared cap (NEXT.md's other suggestion) is fragile: too low truncates
a legitimate multi-file repair; too high re-admits the runaway. It is the fallback
lever, not the primary, and only used in combination with reasoning suppression.

---

## 3. Done criteria

- [x] Probe LM Studio + qwen3.6 for a reasoning-suppression mechanism; the
      working mechanism (or "none honored") is recorded verbatim in
      `process/decisions.jsonl`.
- [x] `src/model-client.mjs` gains a heal-turn "suppress reasoning" request shape
      (wire param when the probe honors one), gated so it fires **only** on heal
      turns (no effect on main loop / staged generation — same scoping discipline
      as phase 236).
- [x] The heal loop issues **one** suppressed-reasoning retry when the first heal
      turn is classified `reasoning_runaway`, instead of aborting immediately
      (`src/healing.mjs` runaway branch + `runHealingIfNeeded` retry plumbing).
- [x] The retry's request shape (suppressed reasoning + chosen cap) is persisted
      to the turn artifact dir for forensics
      (`.kodr/runs/<id>/repairs/turn-N/`).
- [x] `summary.healStopReason` distinguishes "ran away even after suppressed
      retry" from a first-pass runaway (e.g. `reasoning_runaway_after_retry`), and
      `run-summary.mjs` renders it.
- [x] Unit tests cover: heal turn emits the suppression param/shape; main-loop
      and staged turns do NOT; the retry fires exactly once; a successful retry
      yields a repair.
- [x] `npm run format`, tests, and `npm run check` pass.
- [x] Blog post + decisions/failures entries.
- [ ] Live dogfood: a run whose test fails with a trivial fixable error now
      **heals** (or at minimum the heal turn emits non-zero content) instead of
      `reasoning_runaway` with 0 chars.

---

## 4. Implementation notes (specific paths)

### `src/model-client.mjs`

- Add a helper alongside `applyCompletionCap` / `applyRequestParameters` — e.g.
  `applyReasoningSuppression(options, body)` — that injects the probe-blessed
  suppression param **only when `options.completionCapMode === 'heal'` AND
  `options.suppressReasoning === true`**. Wire it into `buildChatRequestBody`
  (line 154-159) after `applyCompletionCap`.
- If the probe blesses `chat_template_kwargs`, shape:
  `{ ...body, chat_template_kwargs: { ...body.chat_template_kwargs, enable_thinking: false } }`.
  Respect a caller override the same way `applyRequestParameters` does
  (`Object.hasOwn(body, 'chat_template_kwargs')` → leave untouched).
- Do **not** remove `max_thinking_tokens` injection — it is harmless when ignored
  and correct for providers that honor it. Suppression is additive and heal-scoped.

### `src/healing.mjs`

- In the runaway branch (`runSelfHealingLoop`, lines 386-418): instead of
  unconditionally `break`ing, if a `repairTurn` retry hook is available and this
  turn has not already been retried, call the repair turn **once more** with a
  flag requesting reasoning suppression, then re-evaluate. Keep the existing
  `break` as the terminal path when the retry also runs away.
- Plumb a new optional flag through the `repairTurn(...)` callback args (e.g.
  `{ index, prompt, repairContext, scratchpad, suppressReasoning }`) so the
  callback in `run-pipeline.mjs` knows to set `suppressReasoning: true` and (per
  the fallback) optionally a tighter cap / `/no_think` prompt prefix.
- Persist `runaway.json` for the first pass and a `runaway-retry.json` (+
  `response.md`) for the suppressed retry in the same `turn-N` dir.
- Set `stopReason = 'reasoning_runaway_after_retry'` when the suppressed retry
  also produces empty output, so the terminal message is distinguishable.

### `src/run-pipeline.mjs`

- In `runHealingIfNeeded` the `repairTurn` callback (lines 2709-2773): read the
  new `suppressReasoning` arg and merge `{ suppressReasoning: true }` into
  `repairOptions` for that call (and, per fallback, optionally override
  `completionReserve`/prepend `/no_think` to `prompt`). Keep the existing
  context-overflow retry (lines 2742-2750) intact and orthogonal.
- Surface the new stop reason: `summary.healStopReason` already passes through
  (`run-pipeline.mjs:1658-1659, 2458`); no schema change needed, only the new
  string value.

### `src/run-summary.mjs`

- Add a branch for `reasoning_runaway_after_retry` near the existing
  `reasoning_runaway` branch (lines 131-148) explaining that reasoning was
  suppressed on the retry and the model still emitted nothing — pointing at a
  model swap rather than a harness lever.

### Scoping guardrail (regression risk)

The cap-starves-main-loop lesson from phase 236 (`src/model-client.mjs:168-176`)
applies here verbatim: reasoning suppression must **never** touch the main
generation loop or the staged implement turns. Gate strictly on
`completionCapMode === 'heal' && suppressReasoning === true`. Add an explicit
regression test that main-loop options (no `completionCapMode`) produce a request
body with **no** suppression param, mirroring the existing
`test/model-client.test.mjs:229` main-loop no-cap guard.

---

## 5. Test plan

### Unit (`node:test`)

In `test/model-client.test.mjs` (extend "completion cap request shaping"):
- heal turn + `suppressReasoning: true` → request carries the blessed suppression
  param (or, fallback build, leaves a marker the heal path uses).
- heal turn + `suppressReasoning` unset → no suppression param.
- main-loop options (no `completionCapMode`) + `suppressReasoning: true` →
  still no suppression param (heal-scope guard).
- staged-retry options → no suppression param (only heal suppresses).

In `test/healing.test.mjs`:
- Inject a `repairTurn` that returns an empty/`finish_reason: length` completion
  on the first call and a valid repair proposal when `suppressReasoning === true`
  → assert the loop retries once, applies the repair, and reports
  `stopReason: 'healed'`.
- Inject a `repairTurn` that runs away on **both** calls → assert exactly one
  retry, then `stopReason: 'reasoning_runaway_after_retry'` and `healed: false`.
- Assert `runaway.json` and the retry artifact are both written.

### Dogfood (per AGENTS.md — generated by Kodr, not a frontier model)

Use `~/src/kodr-testing/phase-260/`:
1. First, the standalone curl probe (record in decisions.jsonl) to pick the
   suppression mechanism.
2. Reproduce the failure: a small task whose generated test fails on a trivial
   error (e.g. a wrong column name / off-by-one). Pre-260 expectation:
   `healStopReason: reasoning_runaway`, 0 content chars.
3. Re-run post-260 against the same task/model. Success = the heal turn emits a
   non-zero repair and ideally `healed: true`; minimum bar = the suppressed retry
   produces content (no more all-reasoning-zero-output).
4. Inspect `repairs/turn-N/runaway.json` + `runaway-retry.json` to confirm the
   retry fired with reasoning suppressed and the answer tokens were non-zero.

Record any harness/app failure discovered in `process/failures.jsonl` and the
blog post.
