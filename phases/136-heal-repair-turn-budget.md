# Phase 136 — Heal Repair-Turn Budget

## Motivation (135 re-validation: the channel works, the heal still can't finish)

Phase 135 fixed the heal *channel* — a tool-using model's captured `edit_file`
calls now land on disk. The live re-validation against qwen confirmed that, and
then exposed the next wall: **every outer heal turn hit
`turn_budget_exhausted`**. The model would `read_file`, issue several
`edit_file` calls, and run out of inner turns before it could re-read, verify,
or recover from a stale hunk.

Evidence (`~/src/kodr-testing/phase-135/heal-revalidate-qwen/` repairs/turn-*):
each outer turn's inner tool loop was capped at **4** turns
(`repairOptions.maxTurns = Math.min(Math.max(options.maxTurns, 1), 4)` in
`runHealingIfNeeded`). A repair that reads then makes 3 edits is already at the
cap — with no turn left to act on the harness's own `no_match` region hints
(turns 2–3 produced stale `edit_file` hunks against lines a prior edit had
already changed; the tool result correctly said "recheck your search text" and
showed the current region, but the budget was spent).

That cap of 4 was sized when repair turns were **one-shot envelope** repairs
(read nothing, emit one JSON proposal). Tool-channel repair is inherently
multi-step: read → edit → (re-read/verify) → recover. The cap throttles the
default-8-turn run down to 4 exactly where it needs room. The feedback channel
is already adequate (the `no_match` tool result carries a current-content region
hint); the only missing ingredient is turns to use it.

## Design principles

1. **Raise the ceiling, don't touch the floor.** Change only the upper bound
   (4 → 8) so a default run (`maxTurns: 8`) gets 8 inner repair turns, while an
   explicit small `--max-turns` is still respected exactly as before. Runs with
   `maxTurns ≤ 4` are unchanged.
2. **Pure, testable unit.** Extract the inline expression into an exported
   `healRepairTurnBudget(maxTurns)` so the budget is documented and unit-tested
   rather than buried in a closure.
3. **Bounded, not unbounded.** Keep a hard ceiling (8) so a large `--max-turns`
   can't make a single heal turn run away on cost/time. Heal is already gated
   (failure-only) and the outer loop stays capped at 3.

## Work items

### A — `healRepairTurnBudget` (`src/healing.mjs`)

- Export `healRepairTurnBudget(maxTurns)` returning
  `Math.min(Math.max(maxTurns | 0 || 1, 1), 8)` — i.e. floor 1, ceiling 8.
  (Behavior identical to the old expression for `maxTurns ≤ 4`; raises the cap
  from 4 to 8 above that.)
- A short comment ties the ceiling to the 135 re-validation evidence.

### B — Use it in `runHealingIfNeeded` (`src/app.mjs`)

- Replace `maxTurns: Math.min(Math.max(options.maxTurns, 1), 4)` with
  `maxTurns: healRepairTurnBudget(options.maxTurns)`. Import the helper.
- No other change; the outer heal `maxTurns` (`Math.min(options.maxTurns, 3)`)
  is intentionally left alone — the evidence points at the inner budget.

## Testing (`node:test`, no live model)

`test/healing.test.mjs`:

- `healRepairTurnBudget(8) === 8` (default run now gets 8, was throttled to 4).
- `healRepairTurnBudget(4) === 4` and `healRepairTurnBudget(2) === 2` and
  `healRepairTurnBudget(1) === 1` (low-end unchanged).
- `healRepairTurnBudget(12) === 8` (ceiling holds).
- `healRepairTurnBudget(0) === 1` (floor holds).

`npm run format`, full `npm test` green (report counts), `npm run check`.

## Live validation (kodr-test-operator, separate)

Re-run the phase-135 qwen `tasks` task. Expect the heal turns to no longer hit
`turn_budget_exhausted` on the first batch of edits, and the heal to make more
progress per turn (ideally reaching `healed: true` when the only faults are the
syntax issue + a couple of logic bugs the model can actually fix in the room it
now has). A still-incomplete heal is an acceptable outcome to report honestly —
what we're validating is that the inner budget is no longer the binding limit.

## Done criteria

- [x] A: `healRepairTurnBudget` exported from `src/healing.mjs`.
- [x] B: `runHealingIfNeeded` uses it (ceiling 4 → 8).
- [x] Tests for the budget function (default raised, low-end unchanged, ceiling
      + floor). Full suite + format + check green.
- [x] `process/decisions.jsonl`: heal inner-loop ceiling raised 4→8 for
      multi-step tool repair (evidence: 135 re-validation `turn_budget_exhausted`).
- [x] Blog post `blog/136-heal-repair-turn-budget.md`.
- [x] NEXT.md: trim the inner-loop-budget half of the "Heal Convergence" item;
      version bumped to 0.0.136; roadmap line checked; committed.
