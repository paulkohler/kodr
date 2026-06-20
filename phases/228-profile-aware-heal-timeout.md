# Phase 228 — Profile-aware heal per-turn timeout for wireNoStream thinking models

## Goal

Make the self-healing loop's per-turn timeout **profile-aware**. When the active profile is a `wireNoStream` thinking model (e.g. qwen3.6) and the user has given no explicit `--repair-timeout-ms`, align the heal per-turn cap with the main-loop per-turn budget (`options.timeoutMs`) under a higher absolute ceiling, instead of throttling it to the fixed 240s default cap. Non-wireNoStream behaviour and explicit overrides are unchanged.

## Why this is next

**The prior framing was wrong.** NEXT.md (and an earlier note) claimed heal failures were "context overflow / accumulated turn-log" / "378k cumulative tokens." That is FALSE and must not be repeated. The 378k figure was the *whole run*, not the heal request. The heal prompt is built **fresh** each turn by `renderLoopRepairPrompt` (= `tests.json` + repair-context files via `buildRepairContext`); it never carries the staged turn-log.

**Re-derived from raw artifacts.** Findings from 36 heal-turn `turn-meta.json` artifacts (`~/src/kodr-testing`, 2026-06-15..20, across phase-201/204/216/219/225/226 and final-audit runs):

- Heal-turn outcome is **uncorrelated with prompt size**. Concrete pairs:
  - 4,730-char heal prompt → timed out at 240s with **0** captured chars.
  - 4,977-char heal prompt → returned **1,190** chars in **14s**.
  - 18,127-char heal prompt → returned **7,289** chars in **116s**.
  - 18,253-char heal prompt → timed out.
  Same-size prompts both succeed and fail. Prompt size is not the lever.

- **Real mechanism.** Heal turns are capped at `min(options.timeoutMs, 240_000)` = **240s** (the `MAX_DEFAULT_REPAIR_TURN_TIMEOUT_MS` "D2" guard), while MAIN-loop turns get the full `options.timeoutMs` = **600s** for the qwen3.6 profile. The same slow wireNoStream thinking model is doing the same shape of work (read → edit → verify) in both cases, so throttling heal to ~40% of the main budget is arbitrary. About **1/3** of heal turns hit exactly 240s. Because **wireNoStream returns nothing until the full response lands**, a timeout is a **total loss** (0 captured chars) — and there is no first-token signal to distinguish slow from hung. Successful heal turns ran as long as 116s, so the tail past 240s is plausibly just-slow, not hung.

**The fix (NEXT.md direction (a) — deterministic, low-risk).** Heal work ≈ main work, so give it the same budget. When `options.wireNoStream` is true and no explicit `--repair-timeout-ms` was given, raise the per-turn cap to `min(options.timeoutMs || DEFAULT, MAX_WIRE_NOSTREAM_REPAIR_TURN_TIMEOUT_MS)` with the new ceiling = 600_000 (so the qwen3.6 heal turn gets the full 600s, exactly like a main turn). Keep the 240s default for non-wireNoStream profiles (the D2 runaway guard for fast local models). Explicit `--repair-timeout-ms` still wins for everyone.

**Honest caveat.** Efficacy on the **>240s tail is UNMEASURED.** We do not know whether the timed-out turns would actually finish at 360s/600s or just waste more time. This phase makes the *principled* change (heal budget = main budget); the loop's dogfood step is the measurement. The tradeoff: a genuinely hung wireNoStream heal turn now wastes up to the new ceiling (~600s) instead of 240s. This is bounded by `maxTurns` (clamped to ≤3) and is consistent with the main loop already accepting 600s/turn.

## Changes

### Design decisions (pinned)

1. **Where the logic lives — inside `runSelfHealingLoop` (`src/healing.mjs`), gated on `options.wireNoStream`.** Rationale: `test/healing.test.mjs` already unit-tests this function directly (the D2 cases call `runSelfHealingLoop` with a synthetic `repairTurn` and assert the recorded `timeoutMs`). Putting the cap selection here makes it directly testable with no live model. `runHealingIfNeeded` (`src/run-pipeline.mjs`) just forwards `wireNoStream: options.wireNoStream`.

2. **New ceiling constant for wireNoStream = 600_000.** A named constant `MAX_WIRE_NOSTREAM_REPAIR_TURN_TIMEOUT_MS = 600_000`. Justification: this aligns the heal per-turn cap with the qwen3.6 profile's main-loop per-turn budget (`profile.timeoutMs` = 600000, surfaced as `options.timeoutMs`). Using `min(options.timeoutMs || DEFAULT, 600_000)` means the heal turn gets *whatever the main turn gets, capped at 600s* — it never exceeds the main budget and degrades gracefully if a smaller `--timeout-ms` is set. The number is not a new free parameter; it is the existing main-loop budget for this profile.

3. **Precedence (exact resulting expression).** Explicit `options.turnTimeoutMs` (from `--repair-timeout-ms`) wins for everyone; then wireNoStream uses the raised ceiling; then the existing 240s default for non-wireNoStream.

4. **Do NOT change** the no-progress / wrong-path turn-count bounds, the `maxTurns` clamp (≤3), or non-wireNoStream behaviour. The existing D2 240s test (which passes NO wireNoStream flag) must still pass unchanged.

### File 1 — `src/healing.mjs`

**Add the new constant** next to the existing repair-timeout constants (after line 14, the `MAX_DEFAULT_REPAIR_TURN_TIMEOUT_MS` block):

```js
const DEFAULT_REPAIR_TURN_TIMEOUT_MS = 60000;
// D2: cap per-turn default to 4 minutes — a repair turn that needs more than
// this on a fast local model is not converging.
const MAX_DEFAULT_REPAIR_TURN_TIMEOUT_MS = 240_000;
// Phase 228: wireNoStream thinking models (e.g. qwen3.6) do the same read->edit->
// verify work in a heal turn as in a main turn, but wireNoStream returns nothing
// until the full response lands, so a timeout is a TOTAL loss (0 captured chars).
// Re-derivation from 36 heal-turn turn-meta.json artifacts (2026-06-15..20) showed
// heal outcome is UNCORRELATED with prompt size (same-size prompts both succeed and
// time out); the real lever is that heal was capped at 240s while main turns get the
// full 600s. Align the heal cap with the main per-turn budget for these profiles.
// (The prior "context overflow / accumulated turn-log" framing was wrong — the heal
// prompt is built fresh and never carries the staged turn-log.) Efficacy on the
// >240s tail is unmeasured; this is the principled change, the dogfood is the test.
const MAX_WIRE_NOSTREAM_REPAIR_TURN_TIMEOUT_MS = 600_000;
```

**Replace the `turnTimeoutMs` computation** at ~lines 188–195.

Before:

```js
	// D2: explicit option wins; otherwise cap the per-turn default to 4 min so
	// a hung local model call doesn't silently consume the full run timeout.
	const turnTimeoutMs = options.turnTimeoutMs
		? options.turnTimeoutMs
		: Math.min(
				options.timeoutMs || DEFAULT_REPAIR_TURN_TIMEOUT_MS,
				MAX_DEFAULT_REPAIR_TURN_TIMEOUT_MS,
			);
```

After:

```js
	// Phase 228: precedence — (1) explicit --repair-timeout-ms (options.turnTimeoutMs)
	// wins for everyone; (2) wireNoStream profiles align the heal per-turn cap with the
	// main-loop per-turn budget (options.timeoutMs) under a 600s ceiling, because heal
	// work == main work and a wireNoStream timeout loses the whole turn; (3) D2: every
	// other (fast local) profile keeps the 4-minute default cap as a runaway guard.
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

Resulting behaviour for the three precedence cases:
- explicit `turnTimeoutMs: 300_000` → `300_000` (unchanged for everyone).
- `wireNoStream: true`, `timeoutMs: 600_000`, no explicit → `min(600_000, 600_000)` = `600_000`.
- non-wireNoStream, `timeoutMs: 600_000`, no explicit → `min(600_000, 240_000)` = `240_000` (D2 default, unchanged).

`turnTimeoutMs` continues to be recorded in each repair entry and in `turn-meta.json` exactly as today (no change to the recording sites).

### File 2 — `src/run-pipeline.mjs`

In `runHealingIfNeeded` (the `runSelfHealingLoop(cwd, testResult, {...})` call at ~line 2533), forward the `wireNoStream` flag. Add a single property line in the options object — place it alongside `timeoutMs: options.timeoutMs,` at ~line 2579:

Before:

```js
		testCommand: options.testCommand,
		timeoutMs: options.timeoutMs,
		// D2: explicit --repair-timeout-ms wins; otherwise healing.mjs applies
		// the min(timeoutMs, 240_000) cap automatically.
		...(options.repairTimeoutMs !== ''
			? { turnTimeoutMs: options.repairTimeoutMs }
			: {}),
		commandRunner,
	});
```

After:

```js
		testCommand: options.testCommand,
		timeoutMs: options.timeoutMs,
		// Phase 228: forward wireNoStream so healing.mjs can raise the per-turn cap to
		// the main-loop budget for wireNoStream thinking models (qwen3.6); fast local
		// profiles still get the D2 240s default. options.wireNoStream is set by
		// applyProfile (model-profiles.mjs) for profiles that declare wireNoStream.
		wireNoStream: options.wireNoStream,
		// D2: explicit --repair-timeout-ms still wins; otherwise healing.mjs applies the
		// profile-aware cap (min(timeoutMs, 600_000) for wireNoStream, else 240_000).
		...(options.repairTimeoutMs !== ''
			? { turnTimeoutMs: options.repairTimeoutMs }
			: {}),
		commandRunner,
	});
```

No other call sites or CLI flags change. `options.wireNoStream` is already populated by `applyProfile` in `src/model-profiles.mjs` (~line 195: `if (profile.wireNoStream) { next.wireNoStream = true; ... }`), so it is reliably `true` for the qwen3.6 default at the heal site and `undefined`/falsy elsewhere.

## Tests

All new tests live in `test/healing.test.mjs`, immediately after the two existing D2 cases (~line 393), and follow the exact D2 pattern: create a temp dir, write a deliberately broken file, run `runVerification` to get a `failed` result, call `runSelfHealingLoop` directly with a synthetic `repairTurn` returning `repairText(...)`, and assert the recorded `timeoutMs` on `result.repairs[0]`. **No live model.**

1. `it('Phase 228: wireNoStream raises the heal turn cap to min(timeoutMs, 600000)')`
   - Call `runSelfHealingLoop` with `wireNoStream: true`, `timeoutMs: 600_000`, `maxTurns: 1`, no `turnTimeoutMs`.
   - Assert `result.repairs[0].timeoutMs === 600_000` (raised from the old 240_000).

2. `it('Phase 228: wireNoStream cap is bounded by the 600000 ceiling, not timeoutMs')`
   - Call with `wireNoStream: true`, `timeoutMs: 900_000`, no `turnTimeoutMs`.
   - Assert `result.repairs[0].timeoutMs === 600_000` (the `MAX_WIRE_NOSTREAM_REPAIR_TURN_TIMEOUT_MS` ceiling wins over the larger main budget).

3. `it('Phase 228: wireNoStream honors a smaller timeoutMs below the ceiling')`
   - Call with `wireNoStream: true`, `timeoutMs: 120_000`, no `turnTimeoutMs`.
   - Assert `result.repairs[0].timeoutMs === 120_000` (`min(120_000, 600_000)` — degrades gracefully when the main budget is smaller than the ceiling).

4. `it('Phase 228: explicit turnTimeoutMs still overrides under wireNoStream')`
   - Call with `wireNoStream: true`, `timeoutMs: 600_000`, `turnTimeoutMs: 300_000`.
   - Assert `result.repairs[0].timeoutMs === 300_000` (explicit `--repair-timeout-ms` wins for everyone, including wireNoStream).

5. `it('Phase 228: non-wireNoStream still capped at 240000')`
   - Call with `timeoutMs: 600_000`, no `wireNoStream`, no `turnTimeoutMs` (i.e. omit the flag entirely).
   - Assert `result.repairs[0].timeoutMs === 240_000` (the D2 default is unchanged when `wireNoStream` is absent/falsy).

Additionally, **confirm the existing D2 tests are untouched and passing** — they carry no `wireNoStream` flag, so under the new code they still resolve to the 240_000 / 300_000 results they already assert:
- `it('D2: default turnTimeoutMs is capped at 240000 when timeoutMs is larger')` → still 240_000.
- `it('D2: explicit turnTimeoutMs overrides the cap')` → still 300_000.

## Dogfood / measurement plan

This is the measurement step for the unmeasured >240s tail. After the change lands and `npm run test` is green:

1. Run a live staged build on the **qwen3.6 (wireNoStream)** profile against a task that has previously driven heal turns into the 240s timeout (reuse a `~/src/kodr-testing` scenario from the phase-225/226/final-audit set, or any task whose first attempt is expected to fail verification so the heal loop engages with `--heal auto --yes`).
2. After the run, inspect the heal `turn-meta.json` artifacts under `<runDir>/repairs/turn-*/turn-meta.json`. For each heal turn, compare `timeoutMs` (should now read `600000`, not `240000`) against the actual elapsed time and `completionChars`.
3. The key question to answer: **do any heal turns that would previously have died at 240s now complete with non-zero `completionChars` in the 240s–600s window?**
   - If yes → the raised cap is converting total losses into successful repairs; the principled change is also empirically validated. Record the observed completion times.
   - If turns simply burn to ~600s with 0 chars → they were genuinely hung, not slow; this informs whether direction (c) (stream heal turns / first-token detection) is worth the risk. Record this too.
4. Capture the run path and the before/after `timeoutMs` + elapsed + `completionChars` per heal turn in the phase notes / `process/decisions.jsonl` follow-up if findings are material. Do not block the phase on a positive result — the phase ships the principled change regardless; the dogfood is the evidence-gathering step.

## Done criteria

- [ ] `src/healing.mjs`: add `MAX_WIRE_NOSTREAM_REPAIR_TURN_TIMEOUT_MS = 600_000` constant with the corrected-forensic comment trail (uncorrelated-with-prompt-size, fresh-prompt, prior-framing-wrong, unmeasured-tail).
- [ ] `src/healing.mjs`: replace the `turnTimeoutMs` expression with the profile-aware `defaultRepairCapMs` form (explicit → wireNoStream 600s ceiling → D2 240s default).
- [ ] `src/run-pipeline.mjs`: `runHealingIfNeeded` forwards `wireNoStream: options.wireNoStream` to `runSelfHealingLoop`, with comment.
- [ ] `test/healing.test.mjs`: add the five new `it(...)` cases above (wireNoStream raises to 600000; ceiling bounds a larger timeoutMs; honors a smaller timeoutMs; explicit override still wins under wireNoStream; non-wireNoStream still 240000).
- [ ] Existing D2 tests (`default ... capped at 240000`, `explicit turnTimeoutMs overrides the cap`) left untouched and confirmed passing.
- [ ] `npm run format` (biome) clean.
- [ ] `npm run test` (full suite) green.
- [ ] `npm run check` green (node --check across all sources + `cversion --check` + skills check).
- [ ] `process/decisions.jsonl`: append a phase-228 entry recording (a) the corrected mechanism (240s vs 600s cap; size-uncorrelated; fresh prompt), (b) the alignment rationale (heal work == main work → same budget, ceiling = profile main budget), (c) the unmeasured-tail caveat, (d) the hung-turn tradeoff bounded by maxTurns ≤3.
- [ ] `blog/228-profile-aware-heal-timeout.md`: new post telling the "operator root-cause was wrong, re-derived from 36 artifacts" story + the profile-aware fix.
- [ ] `NEXT.md`: in the "Heal-turn timeouts on wireNoStream thinking models" candidate, mark direction (a) as **shipped in phase 228**; leave (b) trim-prompt and (c) stream-heal as remaining; update the "Current frontier (phase 227)" heading/note to phase 228.
- [ ] `roadmap.md`: add `- [x] 228 Profile-aware heal per-turn timeout for wireNoStream thinking models` after the 227 line.
- [ ] `package.json`: bump `version` 0.0.227 → 0.0.228 (cversion --check enforces the roadmap/version coupling).
- [ ] Commit (small, single phase, no push).

## Risks / things to watch

- **Unmeasured >240s tail.** We do not yet know whether previously-timing-out heal turns actually complete between 240s and 600s. This phase makes the principled change and relies on the dogfood step for evidence. Do not claim a fix-rate improvement until the dogfood data shows non-zero `completionChars` in the new window.
- **Longer hung-turn waste.** A genuinely hung wireNoStream heal turn now burns up to ~600s instead of 240s. This is bounded by the `maxTurns` clamp (≤3 in `runHealingIfNeeded`) and is consistent with the main loop already accepting 600s/turn. Watch dogfood `turn-meta.json` for turns that hit ~600s with 0 chars — those are the "wasted" cases and signal that direction (c) may be needed.
- **Non-wireNoStream must be identical.** The change is gated entirely on `options.wireNoStream`. Fast local profiles keep the D2 240s cap. The existing D2 tests (no wireNoStream flag) are the regression guard — they must pass unchanged.
- **Explicit override precedence.** `--repair-timeout-ms` (→ `options.turnTimeoutMs`) must still win for everyone, including wireNoStream. Covered by test case 4; do not let the wireNoStream branch shadow the explicit branch (explicit is the outer ternary; the cap selection only feeds the `else`).
- **`options.timeoutMs` source.** The 600s budget flows from `profile.timeoutMs` via `applyProfile` only when `options._timeoutSet` is false; a user `--timeout-ms` would lower both the main and heal budgets together (heal stays `min(timeoutMs, 600_000)`), which is the intended graceful-degrade behaviour (test case 3).
