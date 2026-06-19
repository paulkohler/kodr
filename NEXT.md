# NEXT

Loose, forward-looking candidates only — the rough shape of phases not yet
written. Not a commitment; promote an item into `roadmap.md` + `phases/` when
it is actually next. **Delete an item the moment it ships** — history lives in
the roadmap, phase files, and blog, not here. If a cut idea was really needed it
will resurface on its own.

Current frontier (phase 219): `kodr check` is a comprehensive standalone
diagnostic with `--json`, `--strict`, `--changed`, `--watch`, `--deep`, `--ci`,
`--fix`, and a path argument. Eight cross-reference sensors (canonical name registry +
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
Phase 212 added a `cargo-duplicates` sensor that runs `cargo tree -d --color=never`
in Rust workspaces, parses top-level duplicate crate entries, and flags any crate
that appears at two or more distinct semver major versions. Skips when no
`Cargo.toml` is present or `cargo` is not in PATH.
Phase 213 added a pending-write guard to the `run_command` handler: when
`applyMode===proposal`, `proposalDraft` is non-empty, and the command contains a
pending-write path, returns a synthetic error+hint telling the model to return
the JSON proposal envelope instead of retrying the command.
Phase 214 added a no-subprocess directive and server-startup port pattern to the
`lang:node` builtin skill's HTTP integration test patterns section. Raises the
native-mode budget test limit to 6100 chars.
Phase 215 added W3 draft fallback to runStagedPrompt (mirrors main pipeline) and
extended the Phase-213 run_command guard to intercept bare test-runner commands.
Phase 216 intercepts SafeWriteError at stageIndex > 1 in runStagedPrompt: sets a
steering note injected into the next stage's prompt and continues the loop instead
of breaking. SafeWriteError at stage 1 still breaks. Added "use edit_file for
existing files" to the write_file tool description.
Phase 217 added `ProposalDraft.clearFiles(paths)` and calls it in runStagedPrompt
after each stage's writes are applied — removes applied file paths from the shared
draft so subsequent read_file calls go to disk instead of returning stale
`[pending write — not yet on disk]` labels that contradicted the SafeWriteError
steering note.
Phase 218 added two patterns to the lang:node skill: SQLite `:memory:` in tests
(file-path DB persists state across runs), and the `import.meta.url` server listen
guard (module-scope `app.listen()` binds the port on import, causing EADDRINUSE in
before() hooks). Both patterns eliminated the recurring Grade C pitfalls in
Node.js dogfooding runs.
Phase 219 upgraded the repeat sentinel from a flat `repeat:true` message to a
count-tracking escalation: after 3 consecutive identical tool calls the message
names the count and says "Stop retrying. Return your final proposal now — the
harness will apply writes and run verification automatically." Phase-219 dogfooding
confirmed escalation fires correctly; a new failure class found — in staged mode,
"return your final proposal" is ambiguous and the model writes text instead of
calling write_file for remaining files. The fix is staged-mode-specific sentinel
wording (see candidate below).

## Candidates

### Staged-mode repeat-sentinel wording
Phase-219 dogfooding: in staged mode, "return your final proposal now" redirected
the model to return a plain-text summary instead of calling write_file for the
remaining files. The sentinel message is designed for the non-staged proposal-envelope
flow where the model holds pending files in a JSON block. In staged mode the correct
redirect is: "You are in a staged pipeline. Call write_file for the next file you
need to write. Do not run tests or npm install — verification runs automatically
after all stages complete." Detect staged mode (e.g., via an `inStagedPipeline`
context flag or a separate `sentinelMode: 'staged' | 'envelope'` parameter) and
switch wording accordingly.

### StagedProposalTooLargeError: raise maxStageWrites or auto-split
Phase-219 dogfooding: a 6-file task hit the 5-file per-stage limit and wrote 0
files — hard cliff with no fallback. Either raise `maxStageWrites` to 7–8 (covers
standard project skeletons: server + db + auth + 3 test files), or include the
limit in the staged system prompt so the model autonomously splits the first stage
into ≤5 files and puts remaining files in stage 2.

### npm install auto-run after package.json is applied in staged mode
Phase-216/219 dogfooding: model kept calling run_command(npm install) across
multiple stages; all were blocked by the pending-write guard or TEST_RUNNER_RE.
After stage 1 applied package.json to disk, dependencies were never installed before
stage 2 ran. Tests then failed with ERR_MODULE_NOT_FOUND. Fix: after a stage applies
writes and package.json was among the applied files (and no node_modules exists), run
`npm install --silent` automatically before the next stage starts — same pattern as
the existing depInstall flow in non-staged runs.

### Re-decide the @kodr/repomap publish hold
Parked by decision (2026-06-12: no publish until more dogfooding); the
precondition is now met, so this needs a human call and won't resurface on its
own.

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
