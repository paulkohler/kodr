# Phase 131 — Routing From History (`kodr route`)

## Motivation

Phase 105 built an advisory routing table from bench scores but left activation
explicitly for later ("a future `/model auto` can activate the routing table").
Phases 127/129 then produced a different, cheaper routing signal: per-model
ok-rate over the real run archive, windowable. For a user driving a mix of local
models whose reliability varies wildly (in the repo archive: qwen 67%, nemotron
27%), "which model should I actually use for edits?" is answerable from history.

`kodr route` answers it: of the models you've run enough times, which lands edits
most often — and, with `--apply`, sets it as the project default.

Evidence: phase-105 routing table (advisory); phase-127/129 per-model ok-rate;
NEXT.md "Activate The Routing Table".

## Design principles

1. **History over guess.** The recommendation is computed from actual run
   ok-rate, not a one-off bench. It reuses `computeTrends`.
2. **Guard against small-sample noise.** Only models with `≥ minRuns` (default 3)
   are eligible, and the `unknown` bucket (non-standard run dirs) is excluded — a
   lucky 1/1 must not outrank a solid 14/21. Ok-rate ranks; run count breaks ties.
3. **Advisory by default, opt-in apply.** Plain `kodr route` only prints. `--apply`
   merges the recommended `model` into `.kodr/config.json`, preserving every
   other key and never touching gate keys.

## Work items

### C1 — `src/routing.mjs`

`recommendModel(report, { minRuns })` → `{ recommended, ranked, minRuns,
eligibleCount, totalModels }`. `renderRouteCli(rec, { applied })` → the
recommendation + candidate list, or a helpful message when nothing qualifies.

### C2 — `kodr route` command

`kodr route [--json] [--min-runs N] [--apply] [--runs-dir <dir>]`. Loads trends
over the archive, computes the recommendation, prints it; `--apply` calls
`applyRecommendedModel(cwd, model)` (read-merge-write `.kodr/config.json`,
setting only `model`).

## Testing

- `recommendModel`: highest ok-rate wins; below-minRuns and `unknown` filtered;
  null when nothing qualifies; ties broken by run count.
- `renderRouteCli`: recommendation + candidates; no-qualifier message; applied
  note.
- Live: `kodr route` over the repo archive recommends qwen (67%) over nemotron
  (27%); `--apply` merges `model` into a config while preserving `baseUrl`/
  `testCommand`.
- Full suite, format, check green.

## Done criteria

- [x] C1: `src/routing.mjs` (`recommendModel`, `renderRouteCli`).
- [x] C2: `kodr route` command + `--min-runs`/`--apply`/`--runs-dir` + help;
      `applyRecommendedModel` merge-write.
- [x] Tests (7) for recommend/render; live recommendation + `--apply` config check.
- [x] `process/decisions.jsonl` updated.
- [x] Blog post `blog/131-routing-from-history.md`.
- [x] NEXT.md revised; version bumped to 0.0.131; suite green; committed.
