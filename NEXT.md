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
frontier (see "Model Code Quality" below) is that the *plumbing* works and the
remaining failures are in the *code the local models write*.

## Theme A — Close the loop on what was just built

These are follow-ups the recent phases explicitly left open.

_(Entries are deleted from this file when they ship; history lives in the roadmap, phase files, and blog.)_

### Per-Model-Family Targeted Guidance

Phase 121 shipped the ESM/Node-24 contract block (applies to all Node/ESM
workspaces) and the `node --check` syntax gate. The remaining class: feed
the *recurring per-model* mistake patterns back as targeted guidance injected
only for those model families. gpt-oss has a CJS habit even with the ESM
block; devstral still has argv-parse and `t.assert()` tendencies; qwen has
off-by-one count logic. A model-family fingerprint (matched from the resolved
model string) and a per-family guidance snippet would let the harness give a
more surgical hint than the shared ESM block. Requires live validation to
measure the mistake-class delta before committing to the signal-to-noise
tradeoff. Related open measurement: phase-121's shared ESM block now fires on
greenfield tasks (fixed during 121 validation), but its mistake-REDUCTION
effect is still unmeasured — the operator's 121 runs predated the fix, so the
block was absent. A bench run comparing block-present vs block-absent on the
same task would quantify both the shared block and any per-family additions.
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

### Heal Task Anchoring (anti goal-substitution)

Round 3's worst failure mode: a run reported ok/healed while the requested
CLI was never written — extraction produced zero files, `node --test` found
0 tests, and the heal loop (whose repair prompt carries no original task, no
failurePaths, empty workspace) invented a trivial unrelated module with its
own passing test. Ranked mitigations: repair context inherits the original
user prompt; `writeCount: 0` + zero-tests-found routes to extraction
retry/nudge, not heal; a repair that only creates paths never mentioned in
the task or prior proposal is suspect, not healed. Evidence:
`~/src/kodr-testing/phase-113/greenfield-logstats-1/`.

### Inter-Chunk Idle Deadline

Phase 113 bounds time-to-first-token (120s, one retry), but a stream that
goes silent *mid-read* is still governed only by the overall `timeoutMs` —
gemma's validation stall received a first chunk on retry then hung for the
remaining ~480s. An inter-chunk idle deadline (no SSE data for Ns after
streaming began) would fail such stalls fast with a distinct error, same
pattern as T2.

### Extraction Metadata Into Run Artifacts

Phase 111 attaches `_extractionMeta` (candidateCount, proposalCount, merged)
to merged proposals, but it is not yet written into `summary.json` or shown
by `kodr why` ("proposal assembled from N blocks"). Thread it through.

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

### Cross-Run Forensics

`kodr why` (106) is per-run. The `.kodr/runs/` directory plus the append-only
eval results (100) now hold enough history for aggregate questions: which
pipeline step fails most often, is repair pressure (103) actually converging,
did the edit-format change (102) move the needle. A `kodr trends` or
`kodr why --all` over the run archive would turn the audit trail into the
feedback instrument the harness-engineering arc has been pointing at.

### Bench-Driven Suite Growth

The brownfield suite (100) has eight fixtures. The 109–120 arc generated a
large real-failure record — gpt-oss files[]-boundary corruption, gemma
`<|"|>` pseudo-tokens, qwen duplicate-key collapse, devstral empty-arguments
and mid-session ENOENT, plus the recurring code-quality bugs — and most of
those are still only prose in `process/failures.jsonl`, not executable
fixtures. Promote them: an extractor-replay corpus (the saved raw responses
already exist under `~/src/kodr-testing/`) and brownfield fixtures for the
code-quality traps. This keeps the suite an honest record of what the local
models actually get wrong (the phase-100 pattern) and feeds bench (105)
routing scores for free. Now one of the higher-value Theme B items given how
much real evidence accumulated.

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

1. **Model Code Quality** — the highest-signal direction, and cheap to start
   (the `node --check`-before-done step and the ESM/Node-24 contract line are
   small). It directly raises the green-run rate the arc left on the table.
2. **Bench-Driven Suite Growth** — lock in the arc's hard-won failure evidence
   as executable fixtures before it ages into prose-only history; this also
   gives the code-quality work a measurement baseline.
3. **Daily-driver gaps** — routing activation, watch-meets-TUI, and
   TUI piped-input serialization convert the measurement into real
   workflow (the 104 arc), now that the engine underneath is trustworthy.
4. **Re-decide the repomap publish hold** with the user (precondition met),
   and pick up the **worktree materialise** half of mid-session visibility if
   big-repo proposal-mode verification becomes a felt need.
5. **Theme C (web UI)** when the daily-driver loop is solid enough to be worth
   a second surface.
