# The Heal Turn That Never Heals

Phases 231, 234, 236, 244 built the reasoning-runaway detection machinery: notice
when the model burns its entire token budget on chain-of-thought, emits zero answer
tokens, and fast-fail rather than grinding for five more minutes. That machinery
worked. The problem is what came after: "fast-fail" meant "abort". The repair that
needed to happen never happened.

This phase closes that gap.

## The failure pattern

A typical kodr dogfood session ends with a heal loop triggered by a test failure:
maybe a wrong column name, an off-by-one in a query, a missing export. The fix is
one line. The model should emit it in seconds.

Instead:

```
healing loop fired (reasoning_runaway)
completionTokens: 4094 / 4096
content chars: 0
finish_reason: length
```

Seven thousand reasoning tokens. Zero answer characters. Fast-fail.

The root cause is well-established: LM Studio honors only `max_tokens` for
qwen3.6, bounding reasoning + answer as a single sum. The heal turn sets
`max_tokens: completionReserve` (4096 for the profile). The model reasons until it
hits the ceiling and emits nothing.

The prior approach detected the runaway and aborted. Better than grinding the full
context window. Still broken — the one-line fix never lands.

## The probe

Before committing to a suppression mechanism, I probed LM Studio directly.

**`chat_template_kwargs: { enable_thinking: false }`** — the qwen3 Jinja template
switch. Result: `reasoning_tokens: 184`, content produced (`'DONE'`) at 256 token
budget. The switch does NOT eliminate reasoning — it may reduce it, but the model
still reasons.

**`/no_think` prefix** — the qwen3 soft switch. Result: `reasoning_tokens: 203`,
content produced. Same story: reasoning is not eliminated.

**`max_tokens: 50` + `/no_think`** — tight budget test. Result: `reasoning_tokens:
49`, content empty. Reasoning still fills the cap when the cap is tight enough.

The finding: neither mechanism suppresses reasoning for qwen3.6 under LM Studio.
Both mechanisms allow content production when the budget is sufficient. The
reasoning depth for a trivial prompt is ~180-220 tokens. For a complex repair
prompt, the model reasons far deeper.

## The strategy

Since reasoning cannot be eliminated, the retry strategy is: **compress the budget
so reasoning finishes earlier and leaves room for the answer**.

The suppressed retry:
1. Prepends `/no_think` to the repair prompt (qwen3 soft switch — harmless if
   ignored, possibly effective at the template level).
2. Injects `chat_template_kwargs: { enable_thinking: false }` on the wire request
   via `applyReasoningSuppression` in `model-client.mjs` (heal-only, gated on
   `completionCapMode === 'heal' && suppressReasoning === true`).
3. Halves `completionReserve` (floor 2048). The first attempt used 4096; the retry
   uses 2048. The reasoning depth for a repair prompt at 2048 tokens is unknown
   until dogfood. If the model still burns all 2048 on reasoning, the retry
   produces `reasoning_runaway_after_retry` rather than `reasoning_runaway` — a
   new, distinguishable terminal stop reason.

Whether 2048 is enough for a repair prompt to fit reasoning + answer is an open
empirical question. The phase ships the mechanism; the dogfood will calibrate.

## What was built

**`src/model-client.mjs`** — `applyReasoningSuppression`: injects
`chat_template_kwargs: { enable_thinking: false }` strictly on heal turns when
`suppressReasoning: true`. Caller override wins. Main-loop and staged turns are
never touched — the same scoping discipline as phase 236's `applyCompletionCap`.

**`src/healing.mjs`** — runaway branch restructured. When
`options.suppressThinkingOnRunaway === true`, instead of `break`ing immediately:
1. Persist `runaway.json` (first-pass evidence, unchanged).
2. Issue one suppressed retry with `suppressReasoning: true` and `/no_think`
   prompt prefix.
3. Persist `runaway-retry.json` and optionally `runaway-retry-raw.json`.
4. If the retry also runs away: `stopReason = 'reasoning_runaway_after_retry'`,
   then break.
5. If the retry produces output: swap `completion = retryCompletion`, re-derive
   `turnProposal` / `turnProposalNonEmpty`, fall through to normal proposal parse.

`turnProposal` and `turnProposalNonEmpty` were `const` — changed to `let` so
they can be re-derived after the swap.

**`src/model-profiles.mjs`** — `suppressThinkingOnRunaway: true` added to both
qwen3.6-35b-a3b profiles (provider:'local' and provider:'lmstudio').

**`src/run-pipeline.mjs`** — `repairTurn` callback updated to accept
`suppressReasoning`, build `turnRepairOptions` with `suppressReasoning: true` and
halved `completionReserve` (floor 2048) for the suppressed call. Three new fields
forwarded to `runSelfHealingLoop`: `completionReserve`, `suppressThinkingOnRunaway`,
`contextWindow`.

**`src/run-summary.mjs`** — new branch for `reasoning_runaway_after_retry`:
explains that reasoning was suppressed on the retry, the model still emitted
nothing, and a model swap is indicated.

## The scoping lesson

Phase 236 showed that applying `max_tokens` to the main generation loop starves
it. This phase applies the same guardrail to reasoning suppression:
`applyReasoningSuppression` is gated strictly on `completionCapMode === 'heal' &&
suppressReasoning === true`. Main-loop options (no `completionCapMode`) and
staged-retry options produce no `chat_template_kwargs` injection even when
`suppressReasoning` happens to be set. The test suite covers all four quadrants.

## What's unknown

Whether `max_tokens: 2048` is the right budget for a repair prompt on qwen3.6 is
unmeasured. Reasoning depth for "one wrong column name" is likely far shorter than
for the main generation turn, but unverified. If 2048 still produces all-reasoning
zero-output, the `reasoning_runaway_after_retry` stop reason surfaces it cleanly
for diagnosis.

The cap could be made configurable per-profile. For now the halved floor (min 2048)
is a first-order estimate. The dogfood will tell.
