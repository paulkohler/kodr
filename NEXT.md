# NEXT

Loose, forward-looking candidates only — the rough shape of phases not yet
written. Not a commitment; promote an item into `roadmap.md` + `phases/` when
it is actually next. **Delete an item the moment it ships** — history lives in
the roadmap, phase files, and blog, not here. If a cut idea was really needed it
will resurface on its own.

Current frontier (phase 206): `kodr check` is a comprehensive standalone
diagnostic with `--json`, `--strict`, `--changed`, `--watch`, `--deep`, `--ci`,
`--fix`, and a path argument. Six cross-reference sensors (canonical name registry +
`SENSOR_NAMES` / `SENSOR_SEVERITY` exports; sensors run on applied writes).
`kodr hook install/status/uninstall` manage pre-commit and pre-push gates;
`.kodr/config.json` `hooks` block customises the baked-in command.
Gate-skip reasons are observable via `gateSkips` in JSON output.
`runCrossRefSensorsOnProposal` runs content-safe sensors on dry-run proposals
(`summary.proposalSensors`). Per-sensor toggles via `.kodr/config.json` `sensors`
block (`{ "secret-in-response": false }`) map to `options.sensorToggles`.
Smoke-check heal integration: second heal pass on failure.
`kodr check --fix` synthesises a targeted repair prompt via `buildFixPrompt`
(using `formatSensorIssue` for correct per-sensor issue formatting), routes it
into `runPrompt`, and auto-rechecks after the fix with `fix:false`.
`kodr hook status --json` emits structured JSON output. Help text updated
for hook subcommands, `--fix`, `--watch`, and `sensors`/`hooks` config blocks.
`kodr hook install/uninstall --json` completes the hook JSON surface.
`kodr check --json` includes `fixPrompt` when there are fixable issues.
Phase 205 added thinking-model profile defaults (`wireNoStream`); phase 206
excluded `.kodr` from the inspection file index; phase 207 encoded the five
recurring phase-204 Node.js example pitfalls in the `lang:node` builtin skill.
Phase 208 dogfooding (209a/b) confirmed: inspection context is safe for qwen3.6
on fresh workspaces (0 files indexed → no looping). The looping was caused by
`.kodr/backups/` stale files, not inspection context itself. `--continue`
sessions with existing source files remain untested.

## Candidates

### Re-decide the @kodr/repomap publish hold
Parked by decision (2026-06-12: no publish until more dogfooding); the
precondition is now met, so this needs a human call and won't resurface on its
own.

### Auto-disable inspection context for thinking models
Phase 205 added `wireNoStream` to `applyModelProfileDefaults`. The remaining
gap: `inspectContext` is not set to `false` when `wireNoStream: true`, so
thinking-model runs still require an explicit `--no-inspect-context` flag.
Rescoped: just add `if (profile.wireNoStream) defaults.inspectContext = false`
in `applyModelProfileDefaults`.
Phase-209 study showed qwen3.6 is safe with inspection context on a **fresh
workspace** (0 files indexed). The risky path is `--continue` runs where the
workspace already has substantive source files — untested as of 209b. This
candidate stays live until that path is validated.

### deliveryNudge false-positive path extraction
The nudge that recovers undelivered files fires a second turn and creates files
when it finds path-like strings in freeform prompt or reasoning text, not just
in the model's structured proposal (`files[].path`, `patches[].path`). Phase-209
saw `store.mjs` (no `src/` prefix in the prompt description), `test.txt` and
`files/test.txt` (from `filename="test.txt"` in the multipart body helper)
written as spurious files in both test arms. Tests passed but phantom files are
a correctness problem. Fix: restrict extraction to the structured arrays only.

### Smoke-as-verification in the heal loop
Phase 184 wired a smoke-driven second heal pass, but the in-loop verification
still uses `options.testCommand`. When no testCommand is set, smoke failures
can't drive repairs. Full smoke-as-verification requires pluggable verification
backends: callers pass a `verify` function instead of a `testCommand` string.
Significant architecture change — not yet plannable without an interface sketch.

### Heal-loop context overflow on thinking models
Three rounds of large thinking-model responses exhaust the 32 K context budget
before healing completes, producing an empty final output. This is the
highest-impact systemic issue from phase 204 (`--no-heal` is the current
workaround). Fix options: cap heal turns when `wireNoStream`, drop prior heal
turns from context before each retry, or compress the turn log. Needs design
before it becomes a phase.
