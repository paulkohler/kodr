# Phase 106 — Run Forensics As A Product Surface

Every Kodr run already writes a complete audit trail to `.kodr/runs/<id>/`:
`summary.json`, `writes.json`, `tests.json`, `context.md`, `response.md`, and
more. Until this phase, reading that trail meant opening individual JSON files
and stitching the story together by hand. Phase 106 makes the trail a first-class
product surface.

## What shipped

**`src/forensics.mjs`** — a zero-dependency module with five exports:

- `loadRunAnalysis(runDir)` reads all relevant artifacts in parallel and returns
  a flat object. Missing files come back as `null`; nothing throws.
- `buildCausalStory(analysis)` is a pure function that turns the analysis into
  7 ordered `StoryStep` objects, one per phase of the run pipeline: Context
  Assembly → Model Call → Proposal Extraction → Edit Application → Verification
  → Healing → Final Outcome. Each step carries a `status` (`ok`, `fail`, `warn`,
  `skip`), a `detail` string, and an optional `artifactPath` pointing at the
  file that backs the claim.
- `renderForensicsCli(analysis, story)` renders ANSI-coloured output for the
  terminal.
- `renderForensicsHtml(analysis, story)` returns a complete, self-contained HTML
  page — one string, inline CSS, dark theme, no external assets. Can be opened
  in a browser or streamed from `kodr serve`.
- `resolveRunDir(cwd, runIdOrPath)` resolves the three legal input forms:
  absolute path, bare run ID under `.kodr/runs/`, or empty / `"last"` (reads
  `.kodr/last-run`).

**`kodr why [run-dir]`** — new CLI command. No argument reads `.kodr/last-run`.
`--json` emits the raw story array.

**`GET /runs/:id/why`** — new `kodr serve` route, returns the HTML run-viewer
page.

**`GET /runs/:id/why.json`** — returns `{ runDir, story, summary }` as JSON.

**`/why [run-dir]`** slash command in the TUI. Falls back to `state.lastRunDir`
when no argument given. Uses a dynamic import so the module doesn't add to the
already-large TUI startup path (Node caches it after the first call).

## Design notes

The central design constraint was that `buildCausalStory` must be a pure
function. All I/O is front-loaded into `loadRunAnalysis`; the story builder
takes data and returns data. This made the 10 story-builder tests trivial to
write — no temp files, no mocks, just objects in and step arrays out.

The HTML renderer was deliberately kept simple: a dark theme that mirrors GitHub
Primer colours, left-border colouring by status, and `esc()` on every
user-controlled string before it lands in the template. The XSS test
(`model: '<script>alert(1)</script>'`) catches any renderer regression.

The seven-step causal ordering isn't arbitrary — it maps directly to the five
distinct phases that can fail in a Kodr run (context → model → proposal → apply
→ verify), plus healing (optional repair loop) and the overall outcome. A failed
run will have at least one `fail` step, and the first one is typically the root
cause.

## Failures and near-misses

The `tests.json` schema has an edge case: older runs write `null` (no test
configured) rather than an object with `{ ok, command }`. The story builder
checks for both `null` and the presence of an `ok` field before classifying the
verification step, and the test suite covers both branches.

The server routes needed a `why.json` sub-route so that `why` could be reserved
for HTML content negotiation without a header. The existing `runMatch` regex
(`/^\/runs\/([^/]+)(?:\/([^/]+))?$/`) already handles `why.json` as a single
token, so no regex change was needed.
