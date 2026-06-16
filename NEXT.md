# NEXT

Loose, forward-looking candidates only — the rough shape of phases not yet
written. Not a commitment; promote an item into `roadmap.md` + `phases/` when
it is actually next. **Delete an item the moment it ships** — history lives in
the roadmap, phase files, and blog, not here. If a cut idea was really needed it
will resurface on its own.

Current frontier (phase 147): the plumbing works — extraction, transport,
channels and routing are hardened against real local-model output. The live
failures are now in the *code the local models write* and at *transport edges*
(token-limit truncation, role alternation).

## Candidates

### Deterministic cross-reference sensors (the reviewer's recurring blind spots)
Surfaced by the phase-156-vs-157 comparison (`process/failures.jsonl`
`156-157-comparison`). The smoke-check is load-time only; in `--subagent-stages` mode
the advisory reviewer is the sole correctness gate, and it false-passed two real
defects that a cheap deterministic check would have caught without a model — both are
*cross-references* between two generated files:
- **CSS selector ↔ markup.** `styles.css` styled `#add-btn` and `.container`, neither
  present in `index.html` — required styling silently inert, reviewer passed it. A
  sensor that flags id/class selectors matching no element in any linked HTML catches
  this whole "styled but absent" class deterministically. (Recurred across 155 and 156
  as different variants — it keeps coming back.)
- **`compose build:` ↔ Dockerfile.** `docker-compose.yml` had `api: build: .` with no
  generated Dockerfile (both rounds). Flag a `build:` context with no Dockerfile.
- **Secret column ↔ token/response.** Login signed the whole user row — bcrypt
  `password_hash` included — into the JWT. A heuristic warning when a value selected
  from a `password`/`hash`/`secret`-named column is signed or returned wholesale.
These are sensors (like the syntax gate / smoke-check), not reviewer-prompt tweaks —
deterministic and model-free. Scope a phase around one or two; the CSS-selector one is
the highest-recurrence.

### Smoke-check follow-ups (heal integration + sandbox routing)
The executable smoke-check shipped in phase 156 (`src/smoke-check.mjs`): it
load-probes the entry point and fails the run on a definitive import-time crash, but
two deliberate cuts remain. (1) **Feed a failed smoke into the heal loop** — the
syntax gate already synthesises a verification-shaped result so healing can attempt a
repair (`syntaxResultToVerification`); the smoke-check currently only flips `ok` and
surfaces the error, it doesn't drive an automatic fix. A `smokeResultToVerification`
+ wiring would let the model retry against the real load error. (2) **Route the probe
through the sandbox executor** — it is host-only today and *skipped* when a
Docker/OpenShell executor is active (so it never runs model code on the host to
escape the sandbox), which means sandboxed runs get no load probe at all. Running it
inside the active executor (like the test command already does) would restore
coverage under `--docker-sandbox`. The HTML/static-site case (a load probe can't
`import()` HTML) is a third, separate shape — a headless DOM/script check — not
covered here. A fourth, **only if an artifact shows it bites**: a top-level
`await pool.connect()` / network call in an entry would be classified `failed` on
`ECONNREFUSED` even though the code is fine (no DB at probe time). The phase-155
Express example used a lazy pool and did not trip this, so it stays unhandled until a
real run reproduces it — at which point the dep-missing downgrade pattern in
`classifyLoadFailure` extends naturally (network errors → inconclusive `skipped`).

### Per-step model routing
`--route-auto` (141) picks the best-history model at run start. The open half is
splitting *within* a run: cheap tasks (commit messages, compaction, summaries)
to a `cheapModel`, edits to `editModel`, recording the per-step choice in the
summary so `kodr why` shows which model handled which step. Bigger and riskier —
it touches several internal model-call sites; the `cheapModel` recommendation
can extend `recommendModel`.

### Multi-file *refactor* eval fixture
Separate from the isolation bug above: the eval suite still only measures
single-defect fixes. Plant a cross-file refactor fixture and score it, so
plan-manifest/file-author composition is measured continuously rather than probed
by hand.

### Re-decide the @kodr/repomap publish hold
Parked by decision (2026-06-12: no publish until more dogfooding); the
precondition is now met, so this needs a human call and won't resurface on its
own. (The drift guard for the manual `packages/repomap/src/` copy shipped in
phase 154 — `test/repomap-sync.test.mjs` — independent of the publish decision.)
