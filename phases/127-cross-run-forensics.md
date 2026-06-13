# Phase 127 — Cross-Run Forensics (`kodr trends`)

## Motivation

`kodr why` (phase 106) explains one run — its pipeline steps, where it broke,
why. But the harness-engineering arc has been pointing at a question `why` can't
answer: across *all* the runs in the archive, which step fails most often? Is
healing converging? Which model actually lands edits? The `.kodr/runs/` directory
plus the per-run `summary.json` (every run already writes one) hold the data; it
just has never been aggregated.

This phase adds `kodr trends`: a cross-run report over the run archive. It reads
only existing `summary.json` files — no new artifacts, no new dependencies — and
turns the audit trail into the feedback instrument the arc has been building
toward.

Evidence: `src/forensics.mjs` (`kodr why`, per-run); the `.kodr/runs/` archive;
phase-100 eval results; NEXT.md "Cross-Run Forensics".

## Design principles

1. **Read-only over existing artifacts.** Only `summary.json` is consumed. No
   schema change to runs; old runs aggregate fine, missing/invalid summaries are
   skipped (the archive accretes partial/aborted runs — that's normal).
2. **Attribute each failure once.** A failed run is classified to the *earliest*
   broken step (no-proposal → write-error → nothing-generated → wrong-path →
   verification-failed → heal-exhausted → other), so the failure-step histogram
   sums to the failed-run count.
3. **Compact and honest.** Rates, a failure histogram, per-model ok-rate, token
   averages, first-token-retry total. `--json` for tooling, CLI text for humans.

## Work items

### C1 — `src/trends.mjs`

- `loadRunSummaries(runsDir)`: tolerant scan of `<dir>/*/summary.json`, sorted
  ascending by run id (ISO timestamps).
- `classifyRunFailure(summary)`: earliest-broken-step attribution.
- `computeTrends(summaries)`: ok/proposal/applied/tested/healed counts and
  rates, failure-step histogram, `healStopReasons`, per-model `{runs, ok,
  okRate}`, token averages, first-token-retry total, run-id range.
- `renderTrendsCli(report)`: compact text; empty-archive message.

### C2 — `kodr trends` command

`kodr trends [--json] [--runs-dir <dir>]`, defaulting to `<cwd>/.kodr/runs`.
Help line added.

## Testing

- `loadRunSummaries`: loads valid, skips invalid/missing, `[]` for absent dir,
  ascending sort.
- `classifyRunFailure`: every branch.
- `computeTrends`: rates, failure histogram, per-model ok-rate, token averages,
  empty archive.
- `renderTrendsCli`: empty message; counts/failure/model lines.
- Live: `kodr trends` over the repo archive (67 runs) — 54% ok, failure
  histogram and per-model ok-rate render; `--json` shape verified.
- Full suite, format, check green.

## Done criteria

- [x] C1: `src/trends.mjs` (load, classify, compute, render).
- [x] C2: `kodr trends` command + `--runs-dir`/`--json` + help.
- [x] Tests (9) for load/classify/compute/render.
- [x] Live run over a real archive.
- [x] `process/decisions.jsonl` updated.
- [x] Blog post `blog/127-cross-run-forensics.md`.
- [x] NEXT.md revised; version bumped to 0.0.127; suite green; committed.
