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
excluded `.kodr` from the inspection file index.

## Candidates

### Node.js example pitfalls in the node skill
Four rounds of examples (phase 204) exposed four recurring traps that cost 1–3
extra Kodr runs each time:

1. **node:sqlite BigInt bind** — `lastInsertRowid` is a BigInt; binding it as a
   SQL parameter throws `TypeError: Provided value cannot be bound`. Wrap with
   `Number()` before any SQL bind.
2. **node:sqlite DEFAULT expression** — `DEFAULT (datetime('now'))` is rejected
   as non-constant; use `DEFAULT CURRENT_TIMESTAMP`.
3. **busboy v1 factory** — busboy v1 changed from class to arrow-function
   factory; `new Busboy({...})` throws `TypeError: Busboy is not a constructor`.
   Call it as `Busboy({ headers: req.headers })`.
4. **HTTP server teardown** — `server.close()` alone leaves keep-alive
   connections open; `node --test` hangs 600 s. Must call
   `server.closeAllConnections?.()` before `server.close()`.
5. **port:0 → 0||80 coercion** — `http.request({ port: 0 })` silently becomes
   port 80. Capture the actual port with `server.address().port` inside the
   `listen` callback.

All five should go into `src/builtin-skills/languages/node/SKILL.md` as
explicit code patterns — same file, same root cause class (model trained on
stale APIs / subtle JS coercion).

### Re-decide the @kodr/repomap publish hold
Parked by decision (2026-06-12: no publish until more dogfooding); the
precondition is now met, so this needs a human call and won't resurface on its
own.

### Auto-disable inspection context for thinking models
Phase 205 added `wireNoStream` to `applyModelProfileDefaults`. The remaining
gap: `inspectContext` is not set to `false` when `wireNoStream: true`, so
thinking-model runs still require an explicit `--no-inspect-context` flag.
Rescoped: just add `if (profile.wireNoStream) defaults.inspectContext = false`
in `applyModelProfileDefaults`. The empty-output problem persists in session
logs after 205/206, so this is still live.

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
