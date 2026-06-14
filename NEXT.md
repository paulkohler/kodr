# NEXT

Candidate directions for phases 121+. This is a planning scratchpad, not a
commitment; promote items into `roadmap.md` + `phases/` when chosen. Each item
cites the phase or evidence that motivates it.

## Where the arc stands

Phases 101–108 built the harness-engineering layer (sensors, edit-format
reliability, repair pressure, TUI polish, measured routing, run forensics, the
watch loop, the extracted `@kodr/repomap`) — the harness learned to *measure
itself*. Phases 109–120 then put it under sustained **real-model** load and
rebuilt the core around what that revealed:

- **109–116** dogfooded against gemma-4, gpt-oss-20b, qwen3.6 and devstral and
  hardened extraction: proposal-extraction resilience (111), measured
  structured output (112), stream-first transport (113), an environment-aware
  system prompt (114), structural decode-artifact rules (115), and dot-folder
  skill/agent discovery (116).
- **117–119 (the tool-channel arc)** inverted the central contract: file
  content now rides the constrained tool-call channel, not free-text JSON.
  Capture-into-proposal write tools (117), an empirical tool-support probe with
  per-(model,server) channel selection (118), and envelope demotion to a true
  two-channel model — actions on tools, narration as text, status computed
  from verification (119). The envelope survives as the measured fallback.
- **120** added opt-in `--apply-mode live` so a model's own mid-session
  `run_command` sees its writes (the devstral grounded-loop fix).

The earlier "almost everything is only validated by unit tests" gap is closed:
every recent phase carries a live two-/three-model validation, and
`process/failures.jsonl` is now a substantial real-failure record. The new
frontier is that the *plumbing* works and the remaining failures are in the
*code the local models write*.

- **121** opened the model-code-quality front: a `node --check` syntax gate
  (catch/name/feed-the-heal-loop before the test command) and an ESM/Node-24
  contract block injected on a Node/ESM signal.
- **122** turned that contract from a hardcoded literal into a builtin
  `lang:node` skill — auto-applied on the same `isNodeEsm` trigger,
  override-able by a project/user `lang:node` (any tier), and forensically
  attributable (`summary.languageGuidance.source` = builtin|override, shown by
  `kodr why`). Guidance is now data on the established `lang:<x>` road, not
  prompt code. The mistake-REDUCTION effect remains unmeasured — that is the
  open bench question both 121 and 122 defer to.

## Theme A — Close the loop on what was just built

These are follow-ups the recent phases explicitly left open.

_(Entries are deleted from this file when they ship; history lives in the roadmap, phase files, and blog.)_


### Mid-Session Write Visibility — worktree materialise (deferred from 120)

Phase 120 shipped the steering half: `read_file` on a captured-but-unapplied
path returns the draft content with a `[pending write — not yet on disk]` note,
and `--apply-mode live` lets writes land immediately so mid-session
`run_command` sees real files. The remaining gap is the deeper case: proposal
mode + `run_command` against a captured path. The fix is **materialise** —
apply the `ProposalDraft` to a scratch/working copy (a temp dir or git
worktree) so the model's own `run_command` sees its writes and real mid-session
verification works, while the actual workspace stays gated by review/apply.
This intersects the existing sandbox/worktree machinery (phases 60/76/94).
Evidence: `~/src/kodr-testing/phase-119-devstral/` (the write_file → ENOENT
sequence), `process/failures.jsonl` phase 119-devstral.



### Per-Task Model Routing (default-model activation SHIPPED in 131)

Phase 131 shipped `kodr route`: recommend the best edit model from run-history
ok-rate, and `--apply` sets it as the project default in `.kodr/config.json`.
That activates the *default* model from history. The remaining ambition from
phase 105: **per-task** routing — cheap tasks (commit messages, summaries,
compaction) to `cheapModel`, edits to `editModel` — chosen automatically within a
run, with the per-step model recorded in the summary so `kodr why` shows which
model handled which step. This is the bigger, riskier half (it touches several
internal model-call sites); `kodr route` is the safe, evidence-backed first step
and the `cheapModel` half of the recommendation can extend `recommendModel`.

### Actually Publish @kodr/repomap

**On hold by decision (2026-06-12): no publishing until more dogfooding/testing
has happened.** The sync-check half of this idea can still proceed; the
`npm publish` half waits. (Note 2026-06-13: the 109–120 arc was exactly that
sustained dogfooding — the hold's precondition is largely met, so this is
worth re-deciding with the user rather than leaving indefinitely parked.)

Phase 108 created the package but flagged two open ends: the `packages/repomap/src/`
files are manual copies of `src/repomap/` ("must be updated in the same
commit"), and nothing has shipped to npm. Add a sync check (test that fails
when the trees diverge, or a script that copies and verifies), decide the
source of truth, do the first real `npm publish`, and then make kodr import
the published surface in a way that keeps the zero-runtime-dependency rule
honest (the in-tree copy can remain the import source — the check just keeps
it honest).

## Theme B — Forensics and evals as a flywheel

### Cross-Run Forensics — follow-ons (127 base, 129 windowing, 131 routing, 132 HTML)

Shipped: `kodr trends` (127), `--since`/`--last` windowing + before/after (129),
`kodr route` from per-model ok-rate (131), a self-contained `--html` dashboard
(132), and `kodr evals` score trends over the eval-result record (133). The
forensics-as-instrument arc is complete: run archive and eval scores both
readable the same way. Possible future polish: a combined `kodr trends --html`
that embeds the eval sparklines, but that is cosmetic, not a gap.

### Bench-Driven Suite Growth — code-quality brownfield fixtures (SHIPPED in 123 + 140)

Phase 123 shipped the **extractor-replay** half: `test/fixtures/corpus.json`.
Phase 140 shipped the **brownfield trap-check** half: `cq-brownfield-add-tests`
and `cq-multi-file-esm` in `evals/code-quality.json` — four total cases with
`files_exist` + `content_absent` + `tests_pass` assertions, A/B ready.

The measurement against qwen3.6 is a null (model is inherently clean).
The open capture: run the suite against gpt-oss or devstral to quantify their
trap rate and the guidance block's delta for those families. Still-open corpus
work: devstral empty-arguments (tool_calls shape) and qwen duplicate-key
clusters.


## Theme D — Bigger swings (sequence after A)

- **Multi-file coordinated edits** — the eval suite measures single-defect
  fixes; a phase that plants a cross-file refactor fixture and measures it
  would expose whether plan manifests (91) and file-author subagents (92)
  compose.
- **Incremental index caching** — the structural index (51) and repomap (59,
  95) recompute per run; caching keyed on file hashes would matter for the
  watch loop (107), which re-enters the pipeline on every save.

## Suggested order

The 122–143 session shipped the model-code-quality arc: `lang:node` builtin,
A/B measurement (qwen3.6 null, devstral 2/4→4/4 delta), and model-family
guidance (model:devstral fires from model identity). What remains:

1. **Per-step model routing** — `--route-auto` (141) ships the per-run half:
   the best-history model is selected at run start when no explicit model is
   given. The remaining open work is the **per-step** split: cheap tasks (commit
   messages, compaction, summaries) to a `cheapModel`, edits to `editModel`,
   with the per-step choice recorded in summary so `kodr why` shows which model
   handled which step. That's a bigger, riskier internal change; `--route-auto`
   is the safe, evidence-backed first step.
2. **Re-decide the repomap publish hold** with the user (precondition met), and
   **incremental index caching** (mind the `packages/repomap` mirror) if the
   watch loop's per-save recompute becomes a felt cost.
4. **Web UI follow-ons** (shipped in 134) — live validation run (operator step),
   and any polish that surfaces from real browser use.
