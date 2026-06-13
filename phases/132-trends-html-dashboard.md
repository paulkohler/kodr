# Phase 132 — Trends HTML Dashboard (`kodr trends --html`)

## Motivation

`kodr trends` (127/129) renders a compact CLI report and `--json`. Phase 106 gave
`kodr why` a self-contained HTML forensics page — the same treatment fits the
archive-wide view. A single shareable HTML file (no server, no dependencies) is
the natural artifact for glancing at the whole archive, dropping into a PR, or
opening in a browser without parsing JSON.

## Design principles

1. **Self-contained, dependency-free.** One HTML string, inline CSS, no scripts,
   no external resources — same dark theme as the phase-106 forensics page.
2. **Reuse the report.** `renderTrendsHtml(report, comparison)` takes the exact
   `computeTrends`/`computeComparison` output the CLI/JSON already use. Windowing
   (`--since`/`--last`) and the comparison flow through unchanged.
3. **Escape everything.** Model names and rule ids are echoed into HTML; all go
   through `esc()`.

## Work items

### C1 — `renderTrendsHtml(report, comparison)`

Dashboard with ok/proposal/applied bars, failure-by-step, per-model ok-rate,
extractor-repair frequency, the before/after comparison line, and the
goal-substitution warning (130). Empty-archive page when there are no runs.

### C2 — `kodr trends --html`

`--html` renders the HTML page to stdout (redirect to a file to keep it). Mutually
exclusive with `--json`; windowing flags still apply. Help updated.

## Testing

- Self-contained dashboard with counts + per-model rows; no `<script`/`src=`/
  `href=` (verifies dependency-free).
- Comparison block present when provided.
- HTML-special characters in model names are escaped.
- Empty-archive page.
- Live: `kodr trends --html` over the repo archive renders a valid page.
- Full suite, format, check green.

## Done criteria

- [x] C1: `renderTrendsHtml` (bars, failures, models, repairs, comparison,
      suspect-heal warning, empty page).
- [x] C2: `kodr trends --html` flag + help.
- [x] Tests (4) incl. escaping + dependency-free; live render.
- [x] `process/decisions.jsonl` updated.
- [x] Blog post `blog/132-trends-html-dashboard.md`.
- [x] NEXT.md revised; version bumped to 0.0.132; suite green; committed.
