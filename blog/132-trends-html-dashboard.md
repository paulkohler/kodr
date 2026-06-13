# Phase 132: The Archive, in a Browser Tab

`kodr trends` had two faces: a compact terminal report and `--json` for tooling.
This phase adds a third — `--html` — that renders the whole archive as a single
self-contained web page. No server, no build step, no dependencies: one HTML
string with inline CSS that you redirect to a file and open in a browser, or drop
into a PR for someone to glance at.

It's the same move phase 106 made for `kodr why`, which gave a single run a
shareable forensics page. The archive-wide view deserved the same, and the data
was already shaped for it — `renderTrendsHtml` takes the exact `computeTrends`
output the CLI and JSON already consume. Ok/proposal/applied rates become little
bars, the failure-by-step histogram and per-model ok-rate become tables, the
extractor-repair frequencies from 128 and the goal-substitution warning from 130
ride along, and if you windowed with `--since`, the before/after comparison sits
at the top. Nothing new is computed; it's a second renderer over the same report.

## Dependency-free on purpose

The constitution is strict about runtime dependencies, and a dashboard is exactly
where you'd be tempted to reach for a charting library. The page uses none. Bars
are a `div` with a percentage width; the theme is the same dark palette as the
forensics page; there are no `<script>` tags, no `src=`, no `href=` to anything.
A test asserts that absence directly — if a future edit sneaks in an external
resource, it fails. A self-contained HTML file you can email or commit is worth
more than an interactive chart that needs a CDN, especially for a local-first
tool whose whole point is not depending on the network.

## Where the forensics arc lands

This is the sixth phase in a row to build on the run archive — 127 read it, 128
enriched it, 129 windowed it, 130 flagged suspect heals in it, 131 routed from
it, and 132 puts a face on it. What started as per-run `kodr why` is now a small
product surface: aggregate, comparable, actionable, and viewable. The expensive
work was always the running — hundreds of real local-model runs leaving summaries
on disk. Each of these phases was cheap precisely because that work was already
done; they just kept finding new ways to read it. The archive turned out to be
the most valuable artifact the harness produces, and it was sitting in a
directory the whole time.
