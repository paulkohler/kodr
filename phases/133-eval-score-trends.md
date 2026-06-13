# Phase 133 — Eval Score Trends (`kodr evals`)

## Motivation

`kodr trends` (127–132) reads the live run archive — how often real runs land.
But the harness also has a *measured* signal: the append-only eval results
(phase 100), one scored line per `kodr eval --record` at
`evals/results/<suite>/<model>.jsonl`. That record was write-only — nothing read
it back. `kodr evals` aggregates it into per-suite/per-model score trends, so the
suite's controlled scores and the live archive can be read from the same kind of
instrument. It closes the last "Cross-Run Forensics follow-on" in NEXT.md.

## Design principles

1. **Read-only over existing artifacts.** Only the eval-result JSONL is consumed;
   tolerant of a missing dir or an unparseable line (same posture as `kodr
   trends`).
2. **Trend, not snapshot.** Per suite×model: latest score, run count, first→latest
   delta, best/worst, and a sparkline of scores over time — the eval analog of the
   run archive's before/after.
3. **Pure, testable units.** `loadEvalResults`, `summarizeEvalResults`,
   `sparkline`, `renderEvalTrendsCli` are independent of the CLI.

## Work items

### C1 — `src/eval-trends.mjs`

- `loadEvalResults(dir)`: tolerant scan of `<dir>/*/*.jsonl`.
- `summarizeEvalResults(results)`: group by suite+model, timestamp-ordered, into
  `{ suite, model, runs, latestScore, firstScore, delta, best/worst, scores,
  latestPassCount/TotalCount }`, sorted by suite then latest score.
- `sparkline(scores)` and `renderEvalTrendsCli(pairs)`.

### C2 — `kodr evals` command

`kodr evals [--json] [--runs-dir <dir>]`, defaulting to `evals/results`.

## Testing

- `loadEvalResults`: parseable lines loaded, junk skipped, `[]` for missing dir.
- `summarizeEvalResults`: grouping, ordering, latest/delta/best/worst.
- `sparkline`: 0..1 → glyphs.
- `renderEvalTrendsCli`: empty message; suite/model/latest/trend lines.
- Live: two recorded `kodr eval` runs of the code-quality suite against
  gpt-oss-20b (2/2 each) → `kodr evals` shows "100% latest (2 runs) ██ (0pts)";
  `--json` shape verified. (Eval results are local artifacts, like `.kodr/runs`,
  and are not committed.)
- Full suite, format, check green.

## Done criteria

- [x] C1: `src/eval-trends.mjs` (load, summarize, sparkline, render).
- [x] C2: `kodr evals` command + `--json` + help.
- [x] Tests (6); live recorded-eval validation end-to-end.
- [x] `process/decisions.jsonl` updated.
- [x] Blog post `blog/133-eval-score-trends.md`.
- [x] NEXT.md revised (follow-on closed); version bumped to 0.0.133; committed.
