# NEXT

Loose, forward-looking candidates only — the rough shape of phases not yet
written. Not a commitment; promote an item into `roadmap.md` + `phases/` when
it is actually next. **Delete an item the moment it ships** — history lives in
the roadmap, phase files, and blog, not here. If a cut idea was really needed it
will resurface on its own.

Current frontier (phase 167): verification gates are comprehensive — syntax,
smoke-check, and three cross-reference sensors (compose↔Dockerfile, css↔html,
local-import existence). `kodr check` exposes all three as a standalone
diagnostic with `--json`, `--strict`, and `--no-smoke`/`--no-sensors` control.

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

### `kodr check --changed` (git-aware fast check)
`kodr check` scans the entire workspace. For large repos, a pre-commit hook
only needs to check git-modified files (`git diff --name-only HEAD`). A
`--changed` flag would restrict the write set to unstaged + staged changes,
making the check fast enough to use on every commit.

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

### Import cycle detection
Extend the local-import sensor (phase 167) to detect circular import graphs
(A → B → A). Requires building a dependency graph from all JS files in the
write set and running DFS with a visiting set. Cycles don't crash Node.js but
can produce `undefined` exports at runtime and are hard to diagnose.

### Secret-in-response sensor
Login signed the whole user row — bcrypt `password_hash` included — into the
JWT (surfaced in phase 156/157 logs). A heuristic warning when a value
selected from a `password`/`hash`/`secret`-named variable or column is signed,
serialised, or returned wholesale. Tricky to make precise without a real data-flow
graph — worth scoping as an advisory heuristic that flags the obvious patterns.
