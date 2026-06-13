# NEXT

Candidate directions for phases 109+. Drafted from `README.md`, `roadmap.md`,
the phase files, and the blog posts only — not from a code read — so each item
cites the phase or post that motivates it. This is a planning scratchpad, not a
commitment; promote items into `roadmap.md` + `phases/` when chosen.

## Where the arc stands

Phases 101–108 built the harness engineering layer: sensors and a harness
manifest (101), edit-format reliability (102), repair pressure and no-progress
detection (103), daily-driver TUI polish (104), measured model routing (105),
run forensics (106), the free-token watch loop (107), and an extracted
`@kodr/repomap` package (108). The common thread is that the harness now
*measures itself*. The gap is that almost all of this has been validated by
unit tests and the fake model server, not by sustained real runs against the
local model.

## Theme A — Close the loop on what was just built

These are follow-ups the recent phases explicitly left open.

_(Entries are deleted from this file when they ship; history lives in the roadmap, phase files, and blog.)_

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


### Tool-Channel Arc (phases 118–119; 117 is in phases/)

Thesis: file content has been riding the least-constrained channel (JSON
string values in free-decoded text — the source of ten phases of decode
artifacts and extraction repair) while the most-constrained channel
(grammar-constrained, server-parsed tool calls) is the one agentic-trained
models keep reaching for. gpt-oss corrupted its envelope 4-for-4 while its
hallucinated `write_file` calls were well-formed every time; devstral calls
a native `files` tool exclusively and is 0% usable on the envelope. Phase
117 (Proposal-Capturing Write Tools — see the phase file) adds capture
tools, per-profile aliases, and verification-derived status, strictly
additively. The rest of the arc:

**118 — Tool-Support Probe And Channel Profiles.** LM Studio distinguishes
native tool support (chat template formats the tools array; server parses
tool-call syntax into structured `tool_calls`) from a generic fallback —
reliability is a property of the (model, server, template) triple. Probe
empirically: toy tool request → structured `tool_calls` (native) vs leaked
tool syntax in text (fallback); record `toolSupport` in the model profile;
fold in the management-API context_length check (absorbs the "Probe Reads
The Management API" entry when built). Add `toolWrites:
native|envelope|auto` per profile, auto resolved from probe data — gemma
stays envelope-first until measured otherwise. If 117 shows aliasing isn't
enough, advertise model-native tool names directly in the declared schema.

**119 — Envelope Demotion.** The gut, done last with evidence in hand: for
native-channel profiles the system prompt drops the envelope JSON contract
entirely (large prompt-budget and failure-surface win), final output is
plain text, status is fully verification-derived, and repair/heal turns run
on the tool channel. The extractor and envelope prompt remain for
envelope-mode profiles — fallback, not deleted. Interacts with Heal Task
Anchoring (the repair-context fixes may fold in here).

Out of scope but designed for: Ollama (Modelfile templates) and vLLM
(explicit `--tool-call-parser`) have the same template/parse layer; channel
choice per (model, server) profile transfers unchanged.

### Inter-Chunk Idle Deadline

Phase 113 bounds time-to-first-token (120s, one retry), but a stream that
goes silent *mid-read* is still governed only by the overall `timeoutMs` —
gemma's validation stall received a first chunk on retry then hung for the
remaining ~480s. An inter-chunk idle deadline (no SSE data for Ns after
streaming began) would fail such stalls fast with a distinct error, same
pattern as T2.

### Probe Reads The Management API

LM Studio's management API (`GET /api/v1/models`) reports the *actual* loaded
`context_length`/`parallel` per instance — the GUI had gemma at 8,192 while
kodr's profile assumed 32,768. `kodr probe` could warn on the mismatch (and
`load`/`unload` endpoints exist for future model-flipping in bench).

Extension (2026-06-13): probe tool-call support empirically. LM Studio docs
(/docs/developer/openai-compat/tools) distinguish "native" tool support (chat
template formats the tools array; LM Studio parses the model's tool-call
syntax into structured `tool_calls`) from a generic fallback — and the seam
explains observed failures (leaked `<tool_call|>`/pseudo-token artifacts,
devstral's `arguments:""` crash). Reliability is a property of the
(model, server, template) triple, not the model. Probe: send a one-tool toy
request, check whether the reply carries structured `tool_calls` or tool-call
syntax in text, record `toolSupport: native|fallback` in the model profile.
Same layer exists in Ollama (Modelfile templates) and vLLM (explicit
`--tool-call-parser` flag), so the measurement transfers when other servers
arrive.

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
`npm publish` half waits.

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

The brownfield suite (100) has eight fixtures. Every real failure recorded in
phase 109's burn-in should become a fixture, keeping the suite an honest
record of what the local model actually gets wrong — the same pattern phase
100 used (`process/failures.jsonl` entries became fixtures). This also feeds
bench (105) better routing scores for free.

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

1. **Dogfooding round 2** alongside **routing activation and watch-meets-TUI**
   — the latter two convert existing measurement into daily-driver behavior,
   continuing the 104 arc.
2. **Repomap sync check** when convenient; the publish itself stays deferred
   until testing has built confidence.
3. Pick between themes B and C based on what dogfooding keeps showing: if runs
   are failing, the forensics/eval flywheel pays first; if runs are healthy,
   the web surface is the more interesting build.
