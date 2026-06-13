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

### Trap-Provoking Measurement Fixtures (the redirect from 124)

Phase 124 built the guidance A/B (`--no-language-guidance` + `evals/code-quality.json`)
and got a clean **null** on simple greenfield tasks: gpt-oss and devstral write
clean ESM and real `node:test` with the block on *or* off. The traps from the
117–121 record live in messier conditions — heal-loop repair context, larger or
multi-file edits, multi-turn second-guessing — not first-shot single-file
generation. So the next measurement needs **trap-provoking** fixtures: brownfield
edit cases and heal-pressure cases that actually elicit `require.main`/`t.assert()`,
run through the existing A/B apparatus. Only once a case shows a real mistake
rate can the shared block (or any per-family addition) demonstrate a delta. This
is the gating measurement for the Per-Model-Family work below.
Evidence: `process/failures.jsonl` phase 124-validation.

### Per-Model-Family Targeted Guidance

Phases 121/122 shipped the shared Node/ESM contract (now the builtin `lang:node`
skill) and the `node --check` syntax gate; phase 124 showed it has no measurable
effect on easy tasks. The remaining class: feed the *recurring per-model* mistake
patterns back as targeted guidance injected only for those model families. gpt-oss has a CJS habit even with the ESM block;
devstral still has argv-parse and `t.assert()` tendencies; qwen has off-by-one
count logic. Phase 122 makes the shape obvious: a per-family guidance snippet is
another auto-applied skill (e.g. `model:gpt-oss`) resolved from a model-family
fingerprint (matched from the resolved model string), riding the exact same
discover-override-or-builtin path as `lang:node` — data, not new prompt code.
Requires live validation to measure the mistake-class delta before committing to
the signal-to-noise tradeoff. **Blocked on measurement:** the shared block's
mistake-REDUCTION effect is still unquantified (the 121 operator runs predated
the greenfield fix). A bench run comparing block-present vs block-absent on the
same task would quantify both the shared block and any per-family additions — so
**Bench-Driven Suite Growth should land first** and give this its baseline.
Evidence: `process/failures.jsonl` phases 117/119/120/121-validation.

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

### Heal Relevance Judging (residual from 125)

Phase 125 shipped the first two mitigations for the heal goal-substitution
failure: the repair context now inherits the original user prompt (anchored in
both repair prompts), and a `writeCount: 0` + zero-tests-found run is refused
entry to the heal loop (`stopReason: nothing-generated`, `ok: false`) instead of
inventing a passing module. The **residual** mitigation: the subtler case where
the model writes *something unrelated* — a repair that only creates paths never
mentioned in the original task or prior proposal should be treated as suspect,
not healed. The original-task signal is now in the repair context (125), so this
is judgeable: compare a healed proposal's new paths against task-named targets
and the prior proposal, and flag/quarantine a heal whose only writes are
unrelated. Evidence: `~/src/kodr-testing/phase-113/greenfield-logstats-1/`;
`process/failures.jsonl` phase 113-dogfood.

### TUI Piped-Input Serialization

Piped stdin races in-flight turns: a scripted session ran /status fine, then
the prompt turn was silently abandoned (no request line, no run dir, exit 0)
when buffered /quit hit. The line loop should queue input during a turn and
drain before exiting on EOF.

### Activate The Routing Table

Phase 105's blog states the routing table is advisory and names the follow-up
directly: "A future `/model auto` TUI command can activate the routing table
interactively." Add `/model auto` plus an opt-in config flag so cheap tasks
(commit messages, summaries, compaction) route to `cheapModel` and edits to
`editModel`. Routing decisions should land in the run summary so `kodr why`
can show which model handled which step.

### Watch Meets TUI

Phase 107's watch loop produces pending repair proposals, and the blog's usage
story ("the user reviews it in the TUI") implies an integration that doesn't
exist as a phase yet. Wire `kodr watch` proposals into the same pending-review
state the TUI already has (`/review`, `/accept`, `/reject` from phases 46/98),
or give watch its own minimal accept prompt. Also a natural place to surface
the no-progress guard state to the user instead of silently stopping.

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

### Cross-Run Forensics — follow-ons (base SHIPPED in 127, windowing in 129)

Phase 127 shipped `kodr trends` (cross-run rates, failure histogram, per-model
ok-rate) and phase 129 added `--since`/`--last` windowing with a before/after
ok-rate comparison. Remaining follow-ons: fold the phase-100 append-only eval
results into the same view; an HTML render to match the `kodr why` forensics
page; and feeding the windowed per-model ok-rate into phase-105's routing table
as a retrospective signal (it is now windowable). The per-model ok-rate is the
natural bridge to **Activate The Routing Table** below.

### Bench-Driven Suite Growth — code-quality brownfield fixtures (extractor half SHIPPED in 123)

Phase 123 shipped the **extractor-replay** half: `test/fixtures/corpus.json` is
now a manifest-driven, growable corpus of real corrupt responses (gpt-oss
boundary, gemma pseudo-tokens/collapsed keys), self-documenting and offline.

The remaining half: **brownfield fixtures for the code-quality traps** — plant
the recurring model mistakes (CJS-in-ESM `require.main` in `.mjs`, illegal
top-level `return`, `t.assert()`, argv-as-single-string regex, off-by-one
counts) as eval fixtures in the phase-100 suite, and run them as an A/B bench:
guidance-present vs guidance-absent on the same task, measuring the
mistake-class delta. This is the measurement 121/122 explicitly defer to, and
it unblocks Per-Model-Family Targeted Guidance. It feeds bench (105) routing
scores for free. Still-open captures worth fixturing later: devstral
empty-arguments (a tool_calls-shape case, belongs in a tool-call normalization
corpus, not the extractor corpus) and qwen duplicate-key clusters.

## Theme C — The web channel, for real

### Minimal Web UI Over The Existing Routes

Phase 50 was explicitly "a channel sketch, not a full product UI." Since then
the server grew async run control with SSE (85) and a self-contained HTML
forensics page (106). The pieces for a small dependency-free web UI now exist:
session list, turn submission, SSE progress, and `GET /runs/:id/why` as the
run detail page. Keeping it one static HTML file served by `kodr serve` stays
inside the no-dependency constitution.

## Theme D — Bigger swings (sequence after A)

- **Multi-file coordinated edits** — the eval suite measures single-defect
  fixes; a phase that plants a cross-file refactor fixture and measures it
  would expose whether plan manifests (91) and file-author subagents (92)
  compose.
- **Incremental index caching** — the structural index (51) and repomap (59,
  95) recompute per run; caching keyed on file hashes would matter for the
  watch loop (107), which re-enters the pipeline on every save.

## Suggested order

The 109–120 arc is done; transport, channel, and extraction are solid. What
shifted: the dominant failure mode is no longer the harness but the local
models' code. Suggested sequencing from here:

1. **Bench-Driven Suite Growth** — now the highest-signal direction. Model code
   quality (121/122) shipped the syntax gate and the override-able `lang:node`
   guidance, but *whether the guidance reduces mistakes is unmeasured*, and the
   per-model-family follow-up is explicitly blocked on that measurement. Locking
   the arc's failure evidence in as executable fixtures (extractor-replay corpus
   + code-quality brownfield traps) gives every code-quality lever a baseline
   and feeds bench routing scores for free. Do this before more guidance work.
2. **Per-Model-Family Targeted Guidance** — once a baseline exists, ride the
   phase-122 skill road with `model:<family>` snippets resolved from a model
   fingerprint. Cheap to build, but only worth shipping with a measured delta.
3. **Daily-driver gaps** — routing activation, watch-meets-TUI, and
   TUI piped-input serialization convert the measurement into real
   workflow (the 104 arc), now that the engine underneath is trustworthy.
4. **Re-decide the repomap publish hold** with the user (precondition met),
   and pick up the **worktree materialise** half of mid-session visibility if
   big-repo proposal-mode verification becomes a felt need.
5. **Theme C (web UI)** when the daily-driver loop is solid enough to be worth
   a second surface.
