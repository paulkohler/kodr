# NEXT

Loose, forward-looking candidates only — the rough shape of phases not yet
written. Not a commitment; promote an item into `roadmap.md` + `phases/` when
it is actually next. **Delete an item the moment it ships** — history lives in
the roadmap, phase files, and blog, not here. If a cut idea was really needed it
will resurface on its own.

Current frontier (phase 211): `kodr check` is a comprehensive standalone
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
Phase 208 fixed `extractPromptFilePaths` in the deliveryNudge: strip fenced
code blocks before scanning, require bare names (no `/`) to appear at line
start. Eliminates `test.txt`/`files/test.txt` from code examples and bare
module names mid-sentence. Phase 209 wired `inspectContext = false` to
`wireNoStream` in `applyModelProfileDefaults` — thinking-model runs now
disable inspection context automatically unless `--inspect-context` is
explicitly passed. Phase 210 added a `lang:rust` builtin skill (reqwest 0.12
pin, serde derive, #[tokio::test] pattern, mod declaration) and Rust workspace
detection via Cargo.toml; `renderLanguageGuidanceBlock` now dispatches on a
language tag, making future lang:X skills plug-in without further pipeline
changes. Phase 211 closed the remaining deliveryNudge false positive: path
components from HTTP route descriptions (`files/test.txt` from `GET /files/test.txt`)
are now suppressed by a single preceding-`/` guard in `extractPromptFilePaths`.

## Candidates

### Re-decide the @kodr/repomap publish hold
Parked by decision (2026-06-12: no publish until more dogfooding); the
precondition is now met, so this needs a human call and won't resurface on its
own.

### cargo duplicate-version sensor in kodr check
`cargo tree -d` lists crates that appear at multiple versions in the dependency
graph. Mixing reqwest 0.11 and 0.12 (or tokio 0.x and 1.x) in a workspace
causes `reqwest::Client` type conflicts at crate boundaries that the compiler
rejects. A `kodr check` sensor that runs `cargo tree -d` on Rust workspaces
and flags multi-major duplicates would catch this before the model's output
reaches the test runner. Complements the lang:rust skill pin guidance with a
verification step. Needs design: sensor should only run when `Cargo.toml` is
present and `cargo` is in PATH; report should name the conflicting crate and
its versions.

### llms.txt doc-lookup pattern for skills
When a skill covers a library or API with online docs, encode a `llms.txt`
index URL as the fallback documentation source. Pattern observed in
google/gemma-skills: if an MCP search tool is available use it; else fetch
`https://<domain>/llms.txt` to discover available pages, then fetch specific
pages as needed. A general direction: add a `## Documentation` section to any
builtin skill that has a known `llms.txt` (Express, SQLite, busboy, etc.) so
the model has a live path to current API docs when its training data is stale.
Note: kodr has no external skill registry yet — this applies only to builtin
skills as they are added.

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
