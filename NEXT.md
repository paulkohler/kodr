# NEXT

Loose, forward-looking candidates only — the rough shape of phases not yet
written. Not a commitment; promote an item into `roadmap.md` + `phases/` when
it is actually next. **Delete an item the moment it ships** — history lives in
the roadmap, phase files, and blog, not here. If a cut idea was really needed it
will resurface on its own.

Current frontier (phase 175): `kodr check` is now a comprehensive standalone
diagnostic with `--json`, `--strict`, `--changed`, `--watch`, and a path
argument. Five cross-reference sensors: compose↔Dockerfile, css↔html, local-import
existence, import cycle detection, and secret-in-response. `kodr hook install`
scaffolds a pre-commit gate from the command line.

## Candidates

### Smoke-check heal integration
The executable smoke-check (phase 156) runs after the heal loop. A definitive
smoke failure currently flips `ok` and surfaces the error, but does not drive a
follow-up repair. `smokeResultToVerification` (modelled on `syntaxResultToVerification`
in `syntax-gate.mjs`) would synthesise a verification-shaped result so an
additional heal turn can attempt a repair when smoke fails. The challenge is
architectural: the heal loop precedes the smoke-check in the default pipeline,
so a second heal pass would be needed, or the pipeline order would need to
change (smoke → heal → smoke again).

### Per-step model routing
`--route-auto` (141) picks the best-history model at run start. The open half is
splitting *within* a run: cheap tasks (commit messages, compaction, summaries)
to a `cheapModel`, edits to `editModel`, recording the per-step choice in the
summary so `kodr why` shows which model handled which step. Bigger and riskier —
it touches several internal model-call sites; the `cheapModel` recommendation
can extend `recommendModel`.

### Re-decide the @kodr/repomap publish hold
Parked by decision (2026-06-12: no publish until more dogfooding); the
precondition is now met, so this needs a human call and won't resurface on its
own. (The drift guard for the manual `packages/repomap/src/` copy shipped in
phase 154 — `test/repomap-sync.test.mjs` — independent of the publish decision.)

### `kodr check --json` sensor names in CI output
The `--json` output lists sensor results but doesn't normalise sensor names for
downstream tooling (e.g. `"sensor": "import-cycles"` vs `"sensor": "local-import"`).
Defining a canonical sensor registry and surfacing it in `kodr check --json`
would let CI scripts reliably key on sensor names without brittle string matching.

### Cross-workspace cycle detection
The import-cycle sensor (phase 172) only detects cycles within the write set.
Extending it to follow imports into existing files (full transitive closure) would
catch cycles that span newly-written and pre-existing files. Trade-off: scanning
the full workspace on every check could be slow for large repos.

### `kodr hook uninstall` subcommand
Counterpart to `kodr hook install`. Removes the hook if it was installed by kodr
(same `HOOK_HEADER` guard); warns when the hook exists but was not installed by
kodr (use `rm` directly). Low priority — `rm .git/hooks/pre-commit` is trivial.

### Secret sensor false-positive tuning
The secret-in-response sensor (phase 173) uses a ±4-line window heuristic.
Common false positive: `token` in a CSRF token or OAuth access token context
that is legitimately returned to the client. Could tune with a blocklist of
safe variable names (`csrfToken`, `accessToken`, `refreshToken`) or add a
comment-based suppression mechanism (`// kodr-ignore: secret-in-response`).
