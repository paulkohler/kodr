# Phase 231: When "No Progress" Is a Lie — Detecting Reasoning-Token Runaway

The kodr self-heal loop's most honest failure mode is `no-progress-exhausted`: the
model keeps returning an empty proposal, the loop escalates, escalates again, and
gives up. It is at least truthful. But there is a subtler failure that wears the
same clothes while telling a different story — and phase 231 is about catching it.

## The artifact

The final-audit dogfood from 2026-06-20 (phase-228 ambitious run,
`final-audit/blog-platform`) produced two heal turns. Both returned
`completionChars: 0`. Both burned more than five minutes. The heal loop reported
`stopReason: no-progress-exhausted`. That is wrong.

The raw evidence was in the turn artifacts all along.
`repairs/turn-1/raw-response.json` shows:

```json
{
  "finishReasons": ["length"],
  "content": "",
  "loopBudget": {
    "completionTokens": 21693,
    "promptTokens": 11075,
    "tokens": 32768,
    "stopReason": "finish_length"
  }
}
```

The model produced 21,693 tokens. Every single one of them was reasoning. The
answer section: zero characters. The context window was exactly 32,768 tokens —
the profile's configured `contextWindow`. The model reasoned itself into the wall.

This is a reasoning-token runaway. It is categorically different from "the model
tried and proposed nothing." It is "the model never reached the answering phase."

## What the harness did (wrongly)

Without this phase, the loop receives an empty `completion.text`, feeds it to
`extractJson('')`, gets an empty proposal, finds zero snapshot changes, increments
`noProgressCount`, and — because this is only the first no-progress turn — sends
an escalation prompt for turn 2.

Turn 2's escalation prompt was 3,402 characters. It also ran away to empty,
taking approximately 331 seconds. The harness then reported
`no-progress-exhausted`. Total wasted time: approximately 670 seconds across two
turns, with a misleading diagnostic.

The name matters. "No progress" implies the model considered the problem and
chose not to change anything. "Reasoning runaway" means the model never chose
anything — it was cut off mid-thought with a wall-clock deficit.

## The detection predicate

```js
export function isReasoningRunaway(text, raw, proposalNonEmpty) {
    if (proposalNonEmpty) return false;
    if ((text || '').trim().length > 0) return false;
    if (!raw) return false;
    const finishLength =
        raw.finishReasons?.at(-1) === 'length' ||
        raw.loopBudget?.stopReason === 'finish_length';
    return finishLength === true;
}
```

Four guards, each load-bearing:

**`proposalNonEmpty` first.** A native tool-call repair channel can produce an
empty text response with a valid pre-built proposal. That is a success path, not
a runaway. The check on the tool draft must win.

**`text.trim().length > 0`.** Any real text answer — even a scratchpad-only JSON
— means the model reached the answer phase. Not a runaway.

**`!raw`.** Every existing injected-`repairTurn` test stub returns `{ text }` with
no `raw` field. The `!raw` guard makes the predicate return `false` for all of
them, keeping every pre-existing test on its original no-progress or
invalid-proposal path. This is the regression guard.

**`finishLength` gate.** `finish_reason: "length"` or `stopReason: "finish_length"`
is the only signal that distinguishes a runaway from a model that answered with
nothing. `finish_reason: "stop"` with empty content is a legitimate refusal, and
the existing no-progress path handles that correctly.

## Placement is non-negotiable

The detection branch is inserted after `turnProposalNonEmpty` is computed and
before the proposal-parse `try { ... }` block. Order matters:

- After `turnProposalNonEmpty`: so the proposal-channel guard is available.
- Before the `try`: so a runaway is classified `reasoning_runaway`, never
  `invalid_proposal` (which is what `extractJson('')` throws).

Breaking before the try also means `prepareChanges`, snapshot diffing, and
wrong-path tracking are all bypassed — none of them have anything to measure when
the model produced zero answer tokens.

## The escalation is guaranteed-wasted

Phase 231 breaks on the first runaway turn rather than escalating. The artifact
proves why: the second turn's escalation prompt was only 3,402 characters
(approximately 850 tokens). It still ran away to empty. The model's reasoning
appetite is not proportional to prompt size. A shorter, sharper escalation prompt
does not change the pressure on the context window — the model will still reason
itself to the wall.

Skipping the escalation halves the wasted wall time.

## The run summary now tells the truth

Before phase 231, a reasoning runaway produced:

```
Repairs: not healed (no-progress-exhausted)
```

After:

```
Repairs: not healed (reasoning_runaway) — the model exhausted its context window
on reasoning without emitting a repair (finish_reason: length, 21693 reasoning
tokens / 32768 context). Its thinking budget is not being honored; try a smaller
task or a model with an effective thinking cap.
```

The token counts are real numbers from the repair record. The message is
actionable: the thinking budget is not being honored, and the two levers are task
size and model selection.

## What is deferred

Phase 231 is deliberately narrow: detect and fail fast, accurate diagnostic. It
does not try to fix the underlying cause — which is that kodr sends
`max_thinking_tokens: 4096` but qwen3.6 on LM Studio produces 21,693 reasoning
tokens, implying the cap is being ignored.

Bounding the reasoning budget is a model-coupled problem. The right approach needs
empirical verification: does LM Studio honor `max_thinking_tokens` at all for this
model? What about `max_completion_tokens`? `reasoning_effort`? The answer requires
live param testing — not something deterministically testable at the unit level.
That investigation stays in NEXT.md.

The fast-fail is immediately valuable regardless: one doomed turn instead of two,
an accurate stop reason, and a diagnostic that names the real problem.

## Tests: 1843 → 1848

Five new cases in `test/healing.test.mjs` under
`describe('reasoning-token runaway (phase 231)')`:

- (a) Runaway stops after one turn, `repairs.length === 1`,
  `stopReason: 'reasoning_runaway'`, `repairTurn` called exactly once.
- (b) Repair record carries `runaway` evidence with token counts; `runaway.json`
  written to disk.
- (c) Regression: empty text plus `finish_reason: 'stop'` (the decline case)
  still goes through no-progress → escalate → exhaust in two turns.
- (d) Empty text plus a non-empty tool-channel proposal heals normally — the
  `proposalNonEmpty` guard holds.
- (e) Pure-predicate truth table: nine cases covering every guard branch.

All 1843 pre-existing tests pass unchanged.
