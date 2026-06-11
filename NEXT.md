# NEXT: Strategic Review at Phase 99

The roadmap is complete: every phase from 00 through 99 is checked (84 was removed,
73/74 merged into 94). This document is the strategic case for what phases 100+
should be, based on the roadmap, the blog arc, `process/failures.jsonl`, and the
one deliberately realistic trial (postgres-docs-api).

## Where kodr actually stands

The harness is feature-deep: tool calls, inspection-aware context with an
extractable repomap, an LSP adapter, subagent orchestration with isolated
file-authors, healing loops, sessions with compaction, prompt caching, git-aware
apply/undo, project config, eval suites, and three execution sandboxes. Phases
96–98 closed the worst onboarding friction (config file, auto defaults, the
interactive apply prompt that killed the dry-run dead-end).

But the evidence says the tool is still better at *demonstrating capabilities*
than at *finishing real tasks*. The postgres-docs-api trial — the only example
shaped like real work — is still broken, and the failure trail is the most
valuable document in the repo:

- Repair prompts repeatedly returned an OK envelope with **zero file changes**
  and a scratchpad saying "I need to inspect files." The harness counted that as
  a turn, not as a failure.
- A repair that was told to fix `tests/utils.js` created a root-level `utils.js`
  instead, and the run was reported as if it had progressed.
- Tool-mode repair exhausted its turn budget without converging.

`failures.jsonl` repeats the same theme across phases 71, 84, and 93:
intention-only no-progress turns, invalid JSON envelopes from local models,
models mimicking the wrong response format. **The bottleneck is no longer
missing features. It is the reliability of the edit→verify→repair loop on real
repositories with small local models.**

## The strategic position

Kodr has four genuinely differentiated properties, and the next phases should
each cash in on at least one:

1. **Zero dependencies.** Auditable, installable anywhere Node 24 exists, no
   supply chain. Nothing to do here except not break it.
2. **Local-first means tokens are free.** This is the underexploited one. Aider,
   Claude Code, and Cursor all meter by API cost; their UX is shaped by token
   thrift. A local harness can afford workflows that would be irresponsible on
   a paid API: retry loops, multi-candidate sampling, background repair daemons,
   per-machine benchmarking. Kodr barely uses this advantage today.
3. **Total transparency.** Every request, response, write, and decision is an
   artifact. No competitor offers "show me exactly why this run failed" as a
   first-class object. This should become a *product feature*, not just a
   debugging aid.
4. **Modularity.** The repomap is already boundary-tested for extraction
   (phase 95) but has never been published. An unpublished library is a claim,
   not an asset.

The competitive frame: kodr will not beat Claude Code on raw model quality. It
can win on *trust* (auditability, no data leaves the machine), *cost* (free
tokens enable always-on workflows), and *measurability* (you can know exactly
what your local model can and cannot do). Local model quality is improving fast
— the right posture is to build the measurement and routing infrastructure now,
so each new model generation drops in with zero harness changes.

## Recommended phases

### Phase 100 — Brownfield Edit Eval Suite

Every example so far is greenfield generation. Real developers spend their time
editing existing code, and that is exactly where the postgres trial fell apart.
Build an eval suite of *edit tasks against existing fixture repos*: rename a
function and its call sites, fix a failing test, add a flag to an existing CLI,
repair a deliberately planted bug. Reuse the phase 37 eval runner and assertion
types; add an assertion for "modified the named file rather than creating a
sibling" (directly from the Nemotron `utils.js` failure).

*Why first:* every subsequent phase (edit formats, repair pressure, model
routing) needs a measurement to optimize against. Without this, improvements
are anecdotes. This is also the phase that converts "model quality is improving
fast" from a hope into a dashboard — rerun the suite when a new model lands in
LM Studio and get a score.

### Phase 102 — Edit-Format Reliability

The single biggest lesson from Aider's public benchmarking is that *edit format
is the dominant variable* for small models — whole-file rewrites, unified
diffs, and search/replace blocks have wildly different success rates per model.
Kodr has full-file proposals (phase 10) and unified-diff patches (phases 27/40),
but format choice is static and patch application is brittle. This phase:

- Adds a search/replace-block edit format (the easiest for weak models to emit
  correctly — no line numbers, no hunk math).
- Makes edit format a **model-profile field** (phase 69 registry), measured by
  the phase 100 suite rather than hand-assigned.
- Adds tolerant patch application: when a hunk fails to apply, feed the model a
  structured "this hunk did not match, here is the actual region" message and
  retry, instead of failing the run. Tokens are free; use them.

*Why second:* this is the highest-leverage reliability fix per line of code, and
phase 100 gives it a scoreboard.

### Phase 103 — Repair Pressure And No-Progress Detection

Make the harness refuse to be fooled. Directly from the postgres trial:

- A repair turn that proposes zero writes is **not** an OK envelope; it is a
  no-progress turn. After N consecutive no-progress turns, escalate: re-prompt
  with the unmet goal restated and the scratchpad excerpt quoted back, then fail
  loudly with a distinct stop reason (`no-progress-exhausted`).
- Path-aware repair validation: when the prompt or failure context names a file
  and the proposal creates a differently-pathed sibling instead, flag it in the
  proposal review and the run summary before calling the repair successful.
- Verification-delta tracking: a repair turn that does not change the
  failing-test count gets the test output diff fed back, not just "tests still
  fail."

*Why third:* phases 100/102 make first attempts better; this phase makes the
*loop* converge when first attempts are not enough. Converging loops are what
small models need most.

### Phase 104 — Daily-Driver TUI Session

The TUI works but reads like a debug console. Make `kodr` with no arguments (in
a configured project) open the session loop, and make that loop pleasant within
the line-oriented, zero-dependency constraint:

- Colored in-TUI diff rendering for pending reviews (the ANSI layer from
  phase 77 already exists; `/review` should show a real diff, not a file list).
- `@file` references in prompts that pull a file or repomap symbol into context
  explicitly.
- A visible footer line: model, session, pending review, token totals — the
  phase 41 usage data, surfaced instead of buried in artifacts.
- `/retry` to rerun the last turn (optionally with `--model X`), since free
  tokens make "just try again with the bigger model" a natural gesture.

*Why now:* after 100–103 the runs are worth living in. This is the phase where
someone who is not the author starts kodr in the morning and keeps it open.

### Phase 105 — Measured Model Routing

The phase 69 profile registry plus phase 82 per-agent model specs already allow
manual routing. Make it automatic and *measured*: a small fast model handles
cheap calls (compaction summaries, repomap relevance ranking, commit messages),
the strong model handles planning and edits, and the assignment comes from
phase 100 eval scores per model, not vibes. Add `kodr bench` — run the eval
suite against every model LM Studio is serving and write scores into the
profile registry.

*Why here:* this is the "infrastructure ready for improving models" phase. When
a new 8B model lands that beats your 35B at diffs, `kodr bench` discovers it
and routing uses it the same day. No other tool does per-machine, per-model
empirical routing, because no other tool assumes tokens are free.

### Phase 106 — Run Forensics As A Product Surface

Cash in transparency. Every artifact already exists; the missing piece is the
reader. `kodr why [run-id]` renders a failed (or last) run as a causal story:
what context was packed and why, what the model proposed, which gate stopped
it, what verification said, what the stop reason was — with the artifact paths
inline. Wire the same renderer into `kodr serve` so the existing SSE/HTTP plane
gets a minimal read-only run-viewer page (one dependency-free HTML file, in
keeping with the phase 50 sketch).

*Why:* "I can see exactly why it failed" is kodr's most honest marketing claim
and the thing every local-model user struggles with daily. It also feeds
development: the postgres trial showed diagnosis is where the harness learns.

### Phase 107 — Free-Token Background Loops

The killer local-first application: workflows too token-expensive to run on
metered APIs. One narrow, well-gated entry point: `kodr watch --test "npm
test"` — on file change, run tests; on failure, propose a repair as a *pending
review* (never auto-apply; the phase 98 gate machinery already holds it).
Artifacts and undo make it safe; the phase 103 no-progress detection keeps it
from spinning. Start deliberately small — test-failure repair only.

*Why late:* it composes everything before it (repair convergence, routing,
review gates) and is irresponsible to ship before the loop reliably converges.

### Phase 108 — Publish `@kodr/repomap`

Extract and publish the repomap library that phase 95 prepared. Real package,
real README with the runnable examples, provenance note that it was built by a
harness. Possibly `lsp-client` later, but repomap first — a dependency-free
ranked repo-map is genuinely useful to other tool authors and is the proof of
the modularity claim.

*Why last in this batch:* independent of the rest, lowest urgency, but it
should not slip forever — an extractable library that is never extracted decays
back into app code.

## Sequencing logic in one paragraph

Measure first (100), because everything else optimizes against it. Harness
engineering (101) makes existing controls visible and on by default. Then fix
the two reliability layers in causal order: better first attempts (102), then
converging repair loops (103). Only then invest in the daily-driver surface
(104) — polishing a UI around runs that fail is wasted. Routing (105) needs the
bench from 100 and makes 104/107 dramatically better as models improve.
Forensics (106) can land anytime after 100 but pays most once people use the
tool daily. Background loops (107) are the local-first payoff and must come
after convergence is trustworthy. Publication (108) is parallel-track.

## The user-experience arc

- **Today:** kodr can complete one-shot greenfield tasks against a local model,
  with good artifacts and safe apply gates, but real repair work stalls and the
  user falls back to doing it by hand.
- **After 100–103:** you point kodr at a real repo and edits land reliably for
  your specific model, with a scoreboard proving it; failed loops converge or
  fail loudly with a named reason.
- **After 104–106:** kodr is a session you keep open. It picks the right model
  per task on its own, and when something goes wrong, `kodr why` shows the
  exact request that misfired.
- **After 107–108:** kodr quietly burns your idle GPU on test repairs that wait
  for your review, and a piece of it lives on npm where other people's tools
  depend on it.

## What not to do

- **No more greenfield examples.** Five exist; they no longer find new
  failures. Brownfield evals (100) replace them as the harness's stress test.
- **No web UI buildout** beyond the read-only run viewer in 106. The channel
  contract keeps the option open; a real frontend is a different project.
- **No new sandbox backends.** Docker + OpenShell + worker mode cover the
  threat models. Depth, not breadth.
- **No new model providers** until routing (105) exists — adding endpoints is
  easy; knowing which model to send work to is the actual gap.
