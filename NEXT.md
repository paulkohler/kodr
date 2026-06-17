# NEXT

Loose, forward-looking candidates only — the rough shape of phases not yet
written. Not a commitment; promote an item into `roadmap.md` + `phases/` when
it is actually next. **Delete an item the moment it ships** — history lives in
the roadmap, phase files, and blog, not here. If a cut idea was really needed it
will resurface on its own.

Current frontier (phase 178): `kodr check` is a comprehensive standalone
diagnostic with `--json`, `--strict`, `--changed`, `--watch`, and a path
argument. Five cross-reference sensors: compose↔Dockerfile, css↔html, local-import
existence, import cycle detection, and secret-in-response (with safe-names
allowlist + `// kodr-ignore` suppression). `kodr hook install/uninstall` manage
a pre-commit gate from the command line.

## Candidates

### Sensor name registry
The `--json` output lists sensor results but doesn't normalise sensor names for
downstream tooling (e.g. `"sensor": "import-cycles"` vs `"sensor": "local-import"`).
Defining a canonical sensor registry and surfacing it in `kodr check --json` would
let CI scripts reliably key on sensor names without brittle string matching.

### `kodr hook status` subcommand
Complement to install/uninstall: report whether a pre-commit hook exists, who
owns it (kodr vs foreign), and whether it's up-to-date with the current
install template. Low ceremony — just read and classify the hook file.

### `kodr check` TTY summary line
After all sensors run, print a one-line summary: `3 files · 5 sensors · 2 warnings`.
Gives a quick pulse check without reading the per-sensor lines. Only printed in
TTY mode (not `--json`).

### Cross-workspace cycle detection
The import-cycle sensor (phase 172) only detects cycles within the write set.
Extending it to follow imports into existing files (full transitive closure) would
catch cycles that span newly-written and pre-existing files. Opt-in via `--deep`
to avoid slow scans on large repos.

### Smoke-check heal integration
The executable smoke-check (phase 156) runs after the heal loop. A definitive
smoke failure currently flips `ok` and surfaces the error, but does not drive a
follow-up repair. `smokeResultToVerification` (modelled on `syntaxResultToVerification`
in `syntax-gate.mjs`) would synthesise a verification-shaped result so an
additional heal turn can attempt a repair when smoke fails.

### Per-step model routing
`--route-auto` (141) picks the best-history model at run start. The open half is
splitting *within* a run: cheap tasks (commit messages, compaction, summaries)
to a `cheapModel`, edits to `editModel`, recording the per-step choice in the
summary so `kodr why` shows which model handled which step.

### Re-decide the @kodr/repomap publish hold
Parked by decision (2026-06-12: no publish until more dogfooding); the
precondition is now met, so this needs a human call and won't resurface on its
own.
