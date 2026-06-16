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

### Per-step model routing
`--route-auto` (141) picks the best-history model at run start. The open half is
splitting *within* a run: cheap tasks (commit messages, compaction, summaries)
to a `cheapModel`, edits to `editModel`, recording the per-step choice in the
summary so `kodr why` shows which model handled which step. Bigger and riskier —
it touches several internal model-call sites; the `cheapModel` recommendation
can extend `recommendModel`.

### File-author isolation is illusory (scope bleed)
Retest done (phase-154 investigation; see `process/failures.jsonl`
`154-investigation`). Verdict: cross-file coordination is *correct* — a
qwen `--subagent-stages` run on a two-file cross-dependency task (math.mjs +
calc.mjs importing from it) produced the right wiring (`ok=true`, calc imports the
real exports). The planner manifest and per-file contracts are rich and right.
**But the isolated file-author path (92) does not isolate:** each author's prompt
leads with `parsed.basePrompt` — the full multi-file task — so every author writes
*every* file (both `author-0` and `author-1` proposals were `[math.mjs, calc.mjs]`).
`mergeProposals` dedups to a correct result, hiding N× redundant authoring and
making the "siblings as signatures only" guarantee moot.

Scoped fix: in `renderFileAuthorUserPrompt` (`orchestration.mjs:795`), let the
single-file contract dominate — drop/down-rank the per-file enumeration in the
leading `basePrompt`, keep only global constraints (language/style/async rules) the
manifest can't capture. Design fork to settle: how much prose to retain without
regressing tasks whose nuance lives only in the prose. Before/after is already
captured (before: both authors write both files); validate after across qwen + a
tool-only model.

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
