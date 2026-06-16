# Phase 158: Deterministic Cross-Reference Sensors

The phase-155 and 156 comparison runs surfaced the same class of defect in both
rounds: the advisory reviewer passed generated code that was broken across file
boundaries. Not a typo, not a logic error — a structural mismatch between two
files the reviewer read together and still missed.

Round 1: `styles.css` targeted `#add-btn` and `.container`. Neither id nor class
appeared anywhere in `index.html`. The styles loaded, the page rendered,
everything looked fine — but the required CSS was silently inert. Round 2: same
defect, different selector names. The reviewer passed it both times.

Round 1 and 2 also both produced `docker-compose.yml` with `api: build: .` and
no `Dockerfile`. `docker compose up --build` would fail immediately. The reviewer
read both files and flagged nothing.

These aren't hard problems. They're *cross-references*: a value in one file (a
CSS selector, a compose build context) that must match a value in another
(an HTML attribute, a Dockerfile on disk). A model checking each file in
isolation is structurally blind to them. A deterministic sensor checking the
cross-reference catches them every time.

## The sensors

`src/cross-ref-sensor.mjs` adds two:

**Compose ↔ Dockerfile**: reads every compose file in the write set, extracts
`build:` entries (both `build: .` inline and `build:\n  context: ./path` block
form), resolves the Dockerfile path, and checks if it exists. No YAML parser —
a line-by-line heuristic handles both forms without adding a dependency.

**CSS selector ↔ HTML**: reads HTML files for `id=` and `class=` attributes,
reads linked CSS files for `#id` and `.class` selectors (CSS comments stripped
first), and reports every selector that matches no HTML element. The link is
resolved from `<link rel="stylesheet" href="...">` — relative paths only.

Both sensors return `{ sensor, status, checked, issues, message }`. Status is
`'warn'` for mismatches, `'ok'` when clean, `'skipped'` when no relevant files
were in the write set. The convenience gate `runCrossRefSensors` runs them in
parallel and omits the skipped ones so the summary stays lean.

## Advisory, not blocking

Neither sensor fails the run. They are advisory — the same pattern as `'skipped'`
and `'timeout'` outcomes in the smoke-check. The goal is to surface the signal in
`summary.sensors` and in `kodr why` before deciding whether to promote either to
a blocking gate. A false-positive rate of zero is required before that step, and
that needs to be confirmed by real runs.

The wiring into the pipeline is the next phase.

## The recurring pattern

This is the third time the sensor/gate pattern has replicated itself cleanly:

1. Syntax gate (phase 121): `node --check` catches parse errors the reviewer sees
   as valid.
2. Smoke-check (phase 156): `import()` catches CJS/ESM link-time crashes that
   `node --check` is blind to.
3. Cross-reference sensors (phase 158): structural file-level consistency checks
   the reviewer misses in isolation.

Each one addresses a different layer. The pattern is: wherever the reviewer
demonstrates a consistent blind spot that is cheap to check without a model, a
deterministic sensor belongs there.
