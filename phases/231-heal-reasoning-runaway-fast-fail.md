# Phase 231 — Detect Heal Reasoning-Token Runaway and Fast-Fail

## Motivation

On wireNoStream thinking models (qwen3.6), a self-heal turn can hit a
**reasoning-token runaway**: the model spends its entire completion budget on
chain-of-thought, hits `finish_reason: "length"` with ZERO answer tokens, and
returns empty content before emitting any repair. Verified from
`final-audit/blog-platform/.kodr/runs/2026-06-20T04-45-40.838Z/repairs/turn-1/raw-response.json`:
top-level `finishReasons: ["length"]`, `loopBudget.completionTokens: 21693` (all
reasoning, `content: ""`), `loopBudget.promptTokens: 11075`, `loopBudget.tokens:
32768` (= profile contextWindow), `loopBudget.stopReason: "finish_length"`. kodr
sends `max_thinking_tokens: 4096` but LM Studio/qwen3.6 ignores it.

**Current harmful behavior** (`src/healing.mjs` `runSelfHealingLoop`): an
empty-content runaway turn flows through `extractJson('')` → empty proposal →
`snapshotDiff.changed.length === 0` → `noProgressCount += 1` → the first turn
ESCALATES and runs a SECOND, near-identical heal turn which ALSO runs away to
empty (~331s), then reports `stopReason: 'no-progress-exhausted'`. So a single
runaway costs ~670s across two doomed turns AND mislabels the cause — "no
progress" implies the model tried and changed nothing, when the truth is it
never answered because it exhausted its context window reasoning. Evidence: TWO
heal entries, both `completionChars: 0`, `durationMs` ~335846 and ~331574; the
second turn's prompt was only 3402 chars (the short escalation prompt) yet ALSO
ran away — proving prompt size is NOT the lever.

## Scope (deliberately narrow)

This phase is a **deterministic, model-independent** improvement: detect the
runaway and fail fast with an accurate diagnostic. It does NOT try to force
qwen3 to stop reasoning — that mitigation is model-coupled (depends on whether
LM Studio honors any wire budget param), needs separate empirical verification,
and stays a NEXT.md follow-up. This phase makes the heal loop:

1. **Detect** a reasoning-runaway heal turn.
2. **Stop immediately** on the first such turn — no doomed second turn.
3. Report a distinct, accurate `stopReason: 'reasoning_runaway'` with token
   evidence, so the run summary tells the truth.

## Detection predicate (pure, exported for unit testing)

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

Guards (each load-bearing):
- `proposalNonEmpty` first → a native tool-channel repair (empty text, valid
  draft) is never misclassified.
- `text.trim().length > 0` → any real answer means not a runaway.
- `!raw` → FALSE when `completion.raw` is undefined, which keeps every existing
  injected-`repairTurn` test (returns `{ text }`, no `raw`) on its current path.
- finish-reason gate → FALSE on `stop` with empty content (a legit decline keeps
  the existing no-progress handling).

## Placement

Insert the detection branch **immediately after `turnProposalNonEmpty` is
computed (after line ~335) and BEFORE the proposal-parse `try` (line ~336)**.
This ordering is critical: it guarantees a runaway is classified as
`reasoning_runaway` and never as `invalid_proposal` (whatever `extractJson('')`
does), while a non-runaway empty-text turn with no `raw` still falls through to
the existing `extractJson('')` → `invalid_proposal` path. It also short-circuits
ahead of `prepareChanges`/snapshot/no-progress — a runaway produced nothing to
apply.

```js
if (isReasoningRunaway(completion.text, completion.raw, turnProposalNonEmpty)) {
	const lb = completion.raw?.loopBudget || {};
	const runawayEvidence = {
		finishReason: completion.raw?.finishReasons?.at(-1) ?? null,
		completionTokens: lb.completionTokens ?? null,
		promptTokens: lb.promptTokens ?? null,
		totalTokens: lb.tokens ?? null,
		...(Number.isFinite(options.contextWindow)
			? { contextWindow: options.contextWindow }
			: {}),
	};
	await writeJson(join(turnDir, 'runaway.json'), runawayEvidence);
	stopReason = 'reasoning_runaway';
	repairs.push({
		completionChars,
		durationMs,
		index,
		ok: false,
		promptChars,
		runaway: runawayEvidence,
		stopReason,
		timeoutMs: turnTimeoutMs,
		usage,
	});
	break;
}
```

**Break immediately** (not escalate): the verified artifact shows the short
3402-char escalation prompt also ran away, so a retry is guaranteed-wasted
~331s. There is no signal anywhere in the codebase that escalation rescues an
empty turn.

## Surfacing in the run summary

`src/run-pipeline.mjs` heal-summary renderer (the `Repairs: ...` block, ~lines
3084-3104): add a `reasoning_runaway` branch before the generic `else` that
renders, e.g.:

> Repairs: not healed (reasoning_runaway) — the model exhausted its context
> window on reasoning without emitting a repair (finish_reason: length, N
> reasoning tokens / M context). Its thinking budget is not being honored; try a
> smaller task or a model with an effective thinking cap.

## Consumers of stopReason (grep-verified non-exhaustive — safe to add a value)

`run-pipeline.mjs` (summary passthrough + renderer), `forensics.mjs`
(special-cases only `timeout`, else interpolates), `trends.mjs`
(`classifyRunFailure` equality checks), `harness.mjs`/`server.mjs`
(passthrough). None use an exhaustive `switch`. Optionally extend
`trends.mjs` `classifyRunFailure` to map `healStopReason === 'reasoning_runaway'`
→ `'reasoning-runaway'` so trends attribute it distinctly instead of `'other'`
(verify the function's shape first; only add if it fits cleanly).

## Work items

- [x] Add exported `isReasoningRunaway(text, raw, proposalNonEmpty)` to
  `src/healing.mjs`.
- [x] Insert the detection branch after `turnProposalNonEmpty` and before the
  proposal-parse `try` (write `runaway.json`, push the repair record with the
  `runaway` evidence object, set `stopReason='reasoning_runaway'`, `break`).
- [x] Add the `reasoning_runaway` branch to the `run-pipeline.mjs` heal-summary
  renderer.
- [x] (Optional, verify shape first) `trends.mjs` `classifyRunFailure` →
  `'reasoning-runaway'`. (Added — clean one-liner, no awkwardness.)
- [x] Tests in `test/healing.test.mjs` (`describe('reasoning-token runaway
  (phase 231)')`): (a) runaway stops after ONE turn with
  `stopReason: 'reasoning_runaway'`, `repairs.length === 1`, repairTurn called
  once; (b) runaway record carries token evidence; (c) regression — empty text +
  finish `stop` keeps no-progress→escalate→exhaust (2 turns); (d) empty text +
  NON-EMPTY proposal is not a runaway (applies, heals); (e) pure-predicate truth
  table. Confirm all existing healing tests pass unchanged.
- [x] `npm run format`, run tests, `npm run check`.
- [x] `process/decisions.jsonl`: detect-and-fail-fast NOW vs the model-coupled
  budget fix (deferred to NEXT.md), with the verified ignored-`max_thinking_tokens`
  evidence.
- [x] `process/failures.jsonl`: cross-ref the verified runaway artifact.
- [x] `blog/231-heal-reasoning-runaway-fast-fail.md`: "When 'no progress' is a
  lie: detecting reasoning-token runaway."
- [x] `roadmap.md`: append `- [x] 231 Detect Heal Reasoning-Token Runaway and
  Fast-Fail`.
- [x] `package.json`: bump `0.0.230` → `0.0.231`.
- [x] `NEXT.md`: REWRITE the reasoning-runaway candidate — detection/fast-fail is
  done; keep only the open mitigation (bound the reasoning budget, needs
  empirical LM Studio param testing). Update frontier note to 231.
- [x] Commit.

## Must NOT change (regression guard)

- Timeout/cap logic (phase 228), wrong-path handling, goal-substitution
  detection, the no-progress path for non-runaway empty turns, the success path.
- The `invalid_proposal` path stays reachable for non-runaway empty/garbage text
  (no `raw` length signal).
- Existing healing tests (D1/D2/135/228) pass unchanged — their stubs return
  `{ text }` or `{ text, raw:{ loopBudget:{ usage } } }` with no
  `finishReasons:['length']`, so the predicate is FALSE for them.
