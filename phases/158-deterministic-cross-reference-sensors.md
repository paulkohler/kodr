# Phase 158: Deterministic Cross-Reference Sensors

## Motivation

The advisory reviewer has a consistent blind spot: it false-passes defects that
are *cross-references* between generated files. Two recurred across the phase-155
and phase-156 comparison runs:

- **CSS selector ↔ HTML**: `styles.css` targeted `#add-btn` and `.container`,
  neither present in `index.html` — styling silently inert, reviewer passed.
- **Compose ↔ Dockerfile**: `docker-compose.yml` had `api: build: .` with no
  generated `Dockerfile` (both rounds) — `docker compose up --build` would fail
  immediately, reviewer missed it.

Both are cheap to check deterministically without a model. The syntax gate and
smoke-check already prove that deterministic sensors find what the reviewer
misses. This phase adds two more.

## What this phase does

New file `src/cross-ref-sensor.mjs` with two sensors and a convenience gate:

**Compose ↔ Dockerfile sensor** (`runComposeDockerfileSensor`):
- Detects compose filenames (`docker-compose.yml/yaml`, `compose.yml/yaml`) in
  the write set.
- Parses the file with a line-by-line heuristic (no YAML parser dependency):
  handles inline `build: .` and block form `build:\n  context: ./path`.
- For each `build:` entry, checks whether the Dockerfile exists at the resolved
  context path.
- Returns `{ sensor, status: 'warn', issues, message }` on mismatch; `'ok'`
  when all contexts have a Dockerfile; `'skipped'` when no compose file is in
  the write set.

**CSS selector ↔ HTML sensor** (`runCssSelectorSensor`):
- Detects HTML and CSS files in the write set.
- Parses CSS for `#id` and `.class` selectors (strips comments first).
- Parses HTML for `id=` and `class=` attribute values.
- Links HTML to CSS via `<link rel="stylesheet" href="...">` (relative paths
  only; absolute URLs and data URIs are skipped).
- Returns `'warn'` for every selector that matches no element; `'ok'` when all
  match; `'skipped'` when no HTML/CSS files are in the write set.

**Convenience gate** (`runCrossRefSensors`):
- Runs both sensors in parallel after a write is applied.
- Omits sensors that `'skipped'` (no relevant files) to keep the summary lean.
- Respects `opts.enabled === false` for the planned `--no-sensors` flag.

## Design notes

- Both sensors are **advisory only** (status `'warn'`, not a hard failure). The
  plan is to wire them into the pipeline summary (`summary.sensors`) in the next
  phase and surface them in forensics; failing the run on a CSS mismatch would be
  too aggressive until the sensor has proven precision in real runs.
- The CSS sensor only cross-references files that are *both* (a) in the write set
  *and* (b) linked via `<link>`. If only the CSS changed, the HTML is read from
  disk to support the cross-check.
- YAML parsing is heuristic but handles both forms the model produces. A proper
  YAML parser would add a dependency; the heuristic is sufficient for the common
  docker-compose patterns.

## Done criteria

- [x] `src/cross-ref-sensor.mjs` with `runComposeDockerfileSensor`,
      `runCssSelectorSensor`, `runCrossRefSensors`, and all helpers.
- [x] `test/cross-ref-sensor.test.mjs`: 32 tests, all passing — extract/parse
      unit tests + integration tests via tmp directories.
- [x] `npm run format`, full suite 1540 green, `npm run check` green.
- [x] Decisions logged; blog post; roadmap checked; version bump; committed.
