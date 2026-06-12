# Phase 110: Repair-Loop Discipline

## Goal

Make the healing loop survivable on a slow local model — or conclude that it
cannot be, and remove it. In dogfooding round 1 (phase 109), every greenfield
run lost its repair loop to a silent 600s model-call timeout — healing is
currently a feature that works in tests and dies in practice. This phase
instruments repair turns, makes the timeout a visible, recoverable event,
settles the wrong-path-apply design question, and then renders a verdict.

**Fix-or-remove mandate (user decision, 2026-06-12):** if the repair loop and
heal concepts are not really working after these fixes, remove them as
features rather than carrying a broken capability. The dogfood re-run (D4) is
the trial; D5 records the verdict.

## Evidence

From `~/src/kodr-testing/phase-109/greenfield-wordfreq-1`:

- Run 1 (tools mode): main call ~30s for 2 turns; the single repair call hit
  the full 600,000ms `turnTimeoutMs` and died. `repairs.json` records only
  `stopReason: timeout` — no duration, no token counts, no partial output.
- Run 2 (no-tools): repair turn 1 completed (wrote one of two needed files),
  turn 2 timed out the same way.
- Repair prompts are small (7.3–8.0KB ≈ 1,900 tokens), so prompt size is NOT
  the cause. Unmeasured suspects: completion length (full-file JSON rewrites
  at local tokens/sec) and LM Studio structured-output constraint overhead.
- A wrong-path repair (wrote `wordfreq.mjs` when failures lived in
  `test/wordfreq.test.mjs`) was detected by the phase 103 sensor but applied
  anyway, consuming a heal turn and triggering the turn that timed out.

## Changes

### D1 — Instrument repair turns (src/healing.mjs)

Each entry in `repairs.json` and each `turn-N/` artifact dir records: wall
duration of the model call, prompt chars, completion chars, token usage when
reported, and the configured timeout. On timeout, persist whatever partial
state exists (the prompt is already saved; add the elapsed time and timeout
value). The goal: the NEXT timeout is diagnosable from artifacts alone.

### D2 — Repair-turn timeout becomes a budget, not a cliff (src/healing.mjs, src/app.mjs)

- Default repair `turnTimeoutMs` becomes `min(options.timeoutMs, 240_000)`
  unless explicitly configured — a repair turn that needs more than 4 minutes
  on a local model is not converging, and 10 minutes of silence is what made
  phase 109's timeouts invisible.
- A timed-out repair turn stops the loop with a clear stop reason (it already
  does) AND the run summary + `kodr why` Healing step must say "repair turn N
  timed out after Xs (limit Ys)" instead of a bare `repair_error`/`timeout`.
- Print a user-facing line when a repair turn times out, including the limit
  and how to raise it.

### D3 — Wrong-path gating decision (src/healing.mjs)

Settle the phase 103 open question: when every write in a repair proposal
targets files outside the failing-test set AND the sibling-source heuristic,
do not apply it; record it as `wrong_path_rejected`, feed the warning back,
and let the next turn retry. One rejection per loop — a second wrong-path
proposal ends the loop (no-progress). This converts the observed
waste-a-turn-then-time-out pattern into a steered retry.

### D4 — Reproduce and diagnose the 600s stall (manual, recorded)

Re-run the greenfield wordfreq test under `~/src/kodr-testing/phase-110/`
with D1 instrumentation and the default LM Studio model. Record in
`process/failures.jsonl` what the repair call actually spends its time on
(completion length? structured-output overhead? stall?). If the cause is
structured-output constraint overhead, note it in the model profile docs; a
fix may become its own phase.

### D5 — Verdict: keep or remove healing (decision gate)

After D1–D4, judge the feature on the dogfood evidence: does the heal loop
produce a useful applied repair on a real local-model run within its budget?

- **Keep**: record the verdict and supporting run dirs in
  `process/decisions.jsonl`; healing stays.
- **Remove**: record the verdict the same way, then strip the heal loop and
  repair-pressure surface (`--heal`, `runSelfHealingLoop`, repair artifacts,
  the watch loop's repair proposals — enumerate at removal time). If the
  removal is too large to land safely in this phase, land the verdict +
  deprecation (feature off by default with a clear notice) here and queue the
  excision as the immediate next phase in `NEXT.md`.

## Out of scope

- `/model auto` routing activation (NEXT.md).
- Watch-loop/TUI review integration (NEXT.md).
- Streaming stall-detection for repair calls — only if D4 shows stalls rather
  than slow honest generation.

## Done criteria

- [ ] D1: repair artifacts record duration, sizes, usage, and timeout config
- [ ] D2: capped default repair timeout; timeout surfaced in summary, `kodr why`, and user output
- [ ] D3: wrong-path proposals rejected-with-feedback once, loop ends on repeat
- [ ] node:test coverage for D1–D3
- [ ] D4: greenfield re-run under phase-110/ with findings recorded in `process/failures.jsonl`
- [ ] D5: keep-or-remove verdict recorded in `process/decisions.jsonl` (and acted on)
- [ ] `npm run format`, `npm test`, `npm run check` clean
- [ ] Blog post
- [ ] Roadmap + version bump
- [ ] Commit
