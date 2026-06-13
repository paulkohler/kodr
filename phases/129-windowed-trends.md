# Phase 129 — Windowed Trends (before/after comparison)

## Motivation

`kodr trends` (phase 127) aggregates the whole run archive into rates and
histograms. But the question the measurement thread (phases 124/128) actually
keeps asking is comparative: *did this change move the needle?* A whole-archive
ok-rate can't answer that — a real improvement in the last twenty runs is diluted
by hundreds of older ones. You need to window the archive and compare.

This phase adds windowing to `kodr trends` with a first-class before/after
comparison, so a single invocation can say "ok-rate before 49% → after 88%,
+38 points" around a chosen cut point.

Evidence: phase-127 `kodr trends`; NEXT.md "Cross-Run Forensics follow-ons";
the measurement thread (124/128).

## Design principles

1. **Window, then reuse.** Windowing is a filter over the loaded summaries;
   `computeTrends` is unchanged and runs on the window. No duplicated aggregation.
2. **Before/after in one shot.** `--since <runId>` splits the archive at a run id
   (ISO timestamps are lexicographically ordered) into before/after and reports
   the ok-rate delta. `--last N` windows the most recent N, moving the rest to
   "before". The comparison is the headline answer to "did it help?".
3. **Pure, testable units.** `windowSummaries`, `computeComparison`, and
   `renderComparisonCli` are pure functions, independent of the CLI.

## Work items

### C1 — Windowing in `src/trends.mjs`

- `windowSummaries(summaries, { since, last })` → `{ before, window }`.
- `computeComparison(beforeReport, afterReport)` → `{ beforeRuns, afterRuns,
  beforeOkRate, afterOkRate, okRateDelta }`.
- `renderComparisonCli(comparison)` → the before→after line with a ▲/▼ delta in
  points; a "no prior runs to compare" message when `before` is empty.

### C2 — `kodr trends --since / --last`

The command applies the window, computes the main report on it, and — when a
`before` segment exists — appends the comparison line (CLI) or a `comparison`
object (`--json`). Help line and option defaults added.

## Testing

- `windowSummaries`: `--since` split, `--last` split, no-options passthrough.
- `computeComparison`: rates and delta.
- `renderComparisonCli`: before→after line + delta; no-prior-runs message.
- Live: `kodr trends --last 30` windows; `--since 2026-06-01` over the repo
  archive reports "before 49% → after 88% ▲ +38pts".
- Full suite, format, check green.

## Done criteria

- [x] C1: `windowSummaries` / `computeComparison` / `renderComparisonCli`.
- [x] C2: `--since` / `--last` flags + comparison output (CLI + JSON) + help.
- [x] Tests (6) for windowing/comparison; live windowed runs.
- [x] `process/decisions.jsonl` updated.
- [x] Blog post `blog/129-windowed-trends.md`.
- [x] NEXT.md revised; version bumped to 0.0.129; suite green; committed.
