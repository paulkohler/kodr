# Phase 105 — Measured Model Routing

## Goal

Make model routing automatic and *measured*: a small fast model handles cheap
calls (compaction summaries, repomap relevance ranking, commit messages), the
strong model handles planning and edits, and the assignment comes from eval
scores per model, not vibes. Add `kodr bench` — run the eval suite against
every model LM Studio is serving and write scores into the profile registry.

## Done criteria

- [x] `src/bench.mjs` — pure module with `discoverModels`, `loadBenchScores`,
      `saveBenchScores`, `computeRoutingTable`, `loadRoutingTable`,
      `saveRoutingTable`, `renderBenchResults`.
- [x] `kodr bench --suite <path>` command: discovers all models from LM Studio,
      runs the eval suite against each, saves `.kodr/bench-scores.json` and
      `.kodr/routing.json`.
- [x] `applyModelProfileDefaults` loads and exposes `routingTable` in options
      (advisory, never auto-overrides `options.model`).
- [x] `test/bench.test.mjs` — 22 tests covering all exported functions.
- [x] Existing `model-profiles.test.mjs` updated for the async signature change
      (4 tests still pass).
- [x] `npm run check` clean.
- [x] `roadmap.md` updated.
- [x] `process/decisions.jsonl` updated.
- [x] Blog post written.

## Design decisions

1. **Bench scores stored in `.kodr/bench-scores.json`** — separate from the
   profile registry. The registry is config; scores are runtime data.
2. **Routing table is advisory** — stored in `.kodr/routing.json` and attached
   to options as `routingTable`, but never auto-overrides `options.model`. The
   TUI can surface "suggested model: X" and `/model auto` can activate it in a
   later phase.
3. **`discoverModels` uses native `fetch`** (Node 24 built-in) — no `http`
   module required.
4. **`kodr bench` reuses `runWorkspaceSuite`** from `eval-runner.mjs` — same
   runner as `kodr eval`, just iterated per model.
5. **`applyModelProfileDefaults` is now `async`** — required to load the
   routing table from disk without blocking. All call sites in `app.mjs` and
   `test/model-profiles.test.mjs` await it.
6. **`cheapModel` falls back to `editModel`** when no other model clears the
   threshold (default 0.3). Single-model setups get consistent behaviour.
