# NEXT

Loose, forward-looking candidates only — the rough shape of phases not yet
written. Not a commitment; promote an item into `roadmap.md` + `phases/` when
it is actually next. **Delete an item the moment it ships** — history lives in
the roadmap, phase files, and blog, not here. If a cut idea was really needed it
will resurface on its own.

Current frontier (phase 185): `kodr check` is a comprehensive standalone
diagnostic with `--json`, `--strict`, `--changed`, `--watch`, `--deep`, `--ci`,
and a path argument. Five cross-reference sensors (with canonical name registry
+ `SENSOR_NAMES` export). `kodr hook install/status/uninstall` manage a pre-commit
gate. Smoke-check heal integration: `smokeResultToVerification` adapter + second
heal pass when smoke fails.

## Candidates

### Smoke-as-verification in the heal loop
Phase 184 wired a smoke-driven second heal pass, but the in-loop verification
still uses `options.testCommand`. When no testCommand is set, smoke failures can't
drive repairs. Full smoke-as-verification requires pluggable verification backends
in the heal loop: callers pass a `verify` function instead of a `testCommand` string.
This is a significant architecture change; record here for later.

### Per-step model routing
`--route-auto` (141) picks the best-history model at run start. The open half is
splitting *within* a run: cheap tasks (commit messages, compaction, summaries)
to a `cheapModel`, edits to `editModel`, recording the per-step choice in the
summary so `kodr why` shows which model handled which step.

### Re-decide the @kodr/repomap publish hold
Parked by decision (2026-06-12: no publish until more dogfooding); the
precondition is now met, so this needs a human call and won't resurface on its
own.

### `kodr check --watch --ci`
Combining `--watch` with `--ci` should work naturally (re-run on change using
the CI gate). Verify the combination is exercised in a test and that the summary
line still renders correctly.

### Sensor severity levels
Currently sensors are either `ok`, `warn`, or `skipped`. Some sensors (e.g.
import-cycles) might warrant `error` (harder failure) in strict mode while others
stay advisory. A `severity` field on each sensor result would let `--strict` be
more nuanced than a blanket "all warns become errors".
