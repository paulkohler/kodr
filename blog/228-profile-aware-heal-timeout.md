# Phase 228: Profile-Aware Heal Per-Turn Timeout for wireNoStream Thinking Models

The first explanation was wrong. The fix was not what the wrong explanation suggested.
That sequence — wrong root cause, re-derivation, principled fix — is what this phase is about.

## The wrong framing

NEXT.md held a candidate note that said heal turns were failing due to "context overflow /
accumulated turn-log" and cited a "378k cumulative tokens" figure as evidence. The implication
was that the heal prompt was growing too large, that accumulated turn history was bloating the
request, and that trimming verbatim file embeds would reduce timeouts.

None of that is correct.

The 378k figure was the **whole run** token count, not the heal request. The heal prompt is
built fresh on every turn by `renderLoopRepairPrompt` — it takes `tests.json` (the last
verification output) plus whatever `buildRepairContext` pulls from repair-context files. It
never carries the staged turn-log. There is no accumulation across heal turns. The "context
overflow" framing was confabulation from the wrong level of aggregation.

## Re-derived from 36 artifacts

Thirty-six heal-turn `turn-meta.json` artifacts, collected from
`~/src/kodr-testing` runs across phases 201, 204, 216, 219, 225, 226, and the June 2026
final-audit run, gave a clean picture.

The finding is concrete: **heal-turn outcome is uncorrelated with prompt size.**

| Prompt size (chars) | Result |
|---|---|
| 4,730 | Timed out at 240s — 0 captured chars |
| 4,977 | Returned 1,190 chars in 14s |
| 18,127 | Returned 7,289 chars in 116s |
| 18,253 | Timed out |

Same-size prompts both succeed and fail. The small-prompt that timed out and the
small-prompt that returned 1,190 chars differ by ~250 chars — well within normal
variation. The large prompts go both ways too. Prompt size is not the lever.

## The actual mechanism

About one-third of heal turns hit exactly 240 seconds. That is not a coincidence — 240s is
the `MAX_DEFAULT_REPAIR_TURN_TIMEOUT_MS` "D2" guard introduced as a runaway protection for
fast local models. The main loop's per-turn budget for the qwen3.6 profile is `options.timeoutMs`
= 600s. The heal loop inherits `timeoutMs` from the caller but caps it at 240s. The same slow
wireNoStream thinking model is generating the same shape of work — read → edit → verify — in
both contexts, but the heal path throttled to 40% of the main budget.

`wireNoStream` compounds this: the qwen3.6 profile sends the whole generation in a single
non-streaming HTTP response. There is no first token, no partial content, no signal that
distinguishes slow from hung. A timeout is a **total loss** — 0 captured chars. Successful
heal turns ran as long as 116s, so the tail past 240s is plausibly just-slow, not hung.
We cannot tell without more data, and that is the honest caveat.

## The fix

The fix is a single `defaultRepairCapMs` branch in `runSelfHealingLoop`:

```js
const defaultRepairCapMs = options.wireNoStream
    ? MAX_WIRE_NOSTREAM_REPAIR_TURN_TIMEOUT_MS
    : MAX_DEFAULT_REPAIR_TURN_TIMEOUT_MS;
const turnTimeoutMs = options.turnTimeoutMs
    ? options.turnTimeoutMs
    : Math.min(
            options.timeoutMs || DEFAULT_REPAIR_TURN_TIMEOUT_MS,
            defaultRepairCapMs,
        );
```

The three precedence cases:

1. Explicit `--repair-timeout-ms` → wins for everyone, unchanged.
2. `wireNoStream: true` → heal cap raised to `min(timeoutMs, 600_000)`. For qwen3.6 with the
   default 600s main budget, `min(600_000, 600_000)` = 600_000. If the user passes a smaller
   `--timeout-ms`, the heal cap degrades gracefully to match.
3. Non-wireNoStream → `min(timeoutMs, 240_000)` = D2 default, unchanged.

`runHealingIfNeeded` in `run-pipeline.mjs` forwards `wireNoStream: options.wireNoStream` to
the call. `options.wireNoStream` is already populated by `applyProfile` from
`model-profiles.mjs`, so no new option surface is needed.

The new constant is named `MAX_WIRE_NOSTREAM_REPAIR_TURN_TIMEOUT_MS = 600_000` with a
corrected-forensic comment trail that records what the 36 artifacts showed, why the prior
framing was wrong, and what remains unmeasured.

## What remains unmeasured

Efficacy on the >240s tail is **not yet known**. We do not have data on whether previously-
timing-out heal turns would complete between 240s and 600s, or whether they would simply burn
the new ceiling with 0 chars. That distinction matters for deciding whether direction (c) —
streaming heal turns for wireNoStream so partial output survives — is worth the risk.

The dogfood step after this phase ships is the measurement: run a live staged build on qwen3.6
against a task that historically drives heal turns to the 240s timeout, then inspect
`turn-meta.json` artifacts for any heal turns that now show non-zero `completionChars` in the
240–600s window. If yes: the raised cap converted total losses into successful repairs.
If no: the turns were genuinely hung and direction (c) is the signal.

This phase ships the principled change. The dogfood is the evidence.

## Tests

Five new cases in `test/healing.test.mjs`, following the exact D2 pattern (temp dir, broken
file, synthetic `repairTurn`, assert recorded `timeoutMs`):

1. `Phase 228: wireNoStream raises the heal turn cap to min(timeoutMs, 600000)` → 600_000
2. `Phase 228: wireNoStream cap is bounded by the 600000 ceiling, not timeoutMs` → 600_000
   (timeoutMs: 900_000)
3. `Phase 228: wireNoStream honors a smaller timeoutMs below the ceiling` → 120_000
   (timeoutMs: 120_000, graceful degrade)
4. `Phase 228: explicit turnTimeoutMs still overrides under wireNoStream` → 300_000
   (turnTimeoutMs: 300_000 wins)
5. `Phase 228: non-wireNoStream still capped at 240000` → 240_000 (D2 default unchanged)

The two existing D2 tests carry no `wireNoStream` flag and assert 240_000 / 300_000 —
they are the regression guard and pass unchanged.

Test count: 1817 → 1822.
