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

### Executable smoke-check in verification
Surfaced by the phase-155 stress test (`process/failures.jsonl` `155-stress`). A
qwen+orchestration Express/JWT/pg build was structurally excellent and verified
against a real Postgres — but failed at *startup* on a CJS/ESM trap
(`import { sign, verify } from "jsonwebtoken"`; jsonwebtoken's named exports aren't
statically detectable). The default pipeline missed it: with no test command the
only gate is the advisory model-reviewer, which reads source but never *loads* it.
(The contrast: on a static site the reviewer caught both real bugs by static
reasoning — it's load-time errors that slip through.) Candidate: when a project has
a detectable entry point (package.json `main`/`start`, or `index.html`), add a cheap
deterministic load probe beyond `node --check` — e.g. `import()` the entry in a
child process — so missing-export / CJS-ESM-mismatch / import-time crashes are
caught by verification, not left to the reviewer. Keep it advisory-safe (a failing
smoke-check informs, doesn't necessarily block a dry-run).

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
