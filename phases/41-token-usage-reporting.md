# Phase 41: Token Usage Reporting

## Goal

Loop budgets already track tokens and cost internally (`loop-budgets.mjs`), and
phase 39 made the streaming path capture `usage` too. But the totals are not
surfaced anywhere a user looks: `summary.json` records finish reasons and the
loop-budget snapshot, yet there is no clear per-run token/cost line in the CLI
output or a rollup across runs. Make usage visible.

## Design

- Record aggregate `usage` (prompt/completion/total tokens and cost when present)
  in `summary.json` for every run, sourced from the loop-budget snapshot.
- Print a concise usage line in the non-JSON `kodr run` output (e.g.
  `Tokens: 1,234 (prompt 900 / completion 334)  Cost: $0.0021`).
- Extend `kodr prompt-history` to show per-run token totals alongside the
  existing model / finish-reason / eval columns.
- Handle servers that omit usage gracefully (show `n/a`, never crash).

## Done Criteria

- [x] `summary.json` includes a structured `usage` object per run.
- [x] `kodr run` prints a human-readable usage line in non-JSON mode.
- [x] `kodr prompt-history` surfaces token totals.
- [x] Missing-usage runs degrade gracefully.
- [x] Tests cover usage capture, formatting, and the missing-usage path.
- [x] Record decisions and any failures.
- [x] Blog post.
