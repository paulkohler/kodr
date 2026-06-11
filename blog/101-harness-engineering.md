# Phase 101: Making the Harness Opinionated

Kodr already had most of the controls. Phase 99 added a real LSP adapter that
speaks JSON-RPC over stdio. Earlier phases added verification, healing, safe
writes, dependency install. The issue going into phase 101 was that these
controls were mostly dark: opt-in, disconnected from each other, invisible in
run output. Martin Fowler and Birgitta Böckeler's writing on harness engineering
frames this well — "keep quality left" means the controls that catch errors
should run close to the code change, not as a separate after-the-fact pass. The
healing loop had test failures to work with but not diagnostic errors. The LSP
adapter collected diagnostics and attached them to `InspectedFile` objects where
no downstream consumer read them. Phase 101 is about closing those gaps.

## The LSP Default Flip

Phase 99 shipped with `lsp: false` as the default. The reasoning was sound at
the time: LSP can execute repository code (`rust-analyzer` runs build scripts,
`gopls` invokes the go toolchain), so defaulting it off felt safe. But `false`
means kodr never probes for available servers, never collects diagnostics, and
the whole LSP machinery only activates if the user adds a flag or config key.
Most users won't.

The phase 101 default is `'auto'`. The tri-state matters:

- `false` — never probe, never spawn anything
- `'auto'` — probe silently at startup, enable for servers that respond, disable
  cleanly if none exist
- `true` or `['gopls', ...]` — enable specific servers explicitly

`'auto'` is safe because the probe is just a `--version` check, not a full LSP
session. If nothing responds, kodr behaves exactly as it did with `false`. If
gopls is installed, it gets used. The user gets LSP coverage for free on
machines where the toolchain is already present, and nothing breaks on machines
where it isn't.

`lspEntryAllowed` in `external-inspector-registry.mjs` now handles `'auto'`
explicitly rather than falling through to the boolean branch. `project-config.mjs`
validates and displays it as a first-class value rather than coercing it to
`true`. `kodr run --show-config` says `lsp: auto (auto-detected)` instead of
silently misreporting.

## Post-Write Diagnostics: Quality Left

The existing flow was: apply writes → run tests → if tests fail, heal. The gap
is that tests run after the full write batch, and a diagnostic error on a
written file (a type error, an import that doesn't resolve) might cause a test
failure that looks like a logic bug rather than a structural problem. The healing
loop then crafts a repair prompt around the symptom, not the cause.

`src/post-write-sensor.mjs` inserts a step between apply and test:
re-inspect changed files via LSP immediately after writes land. The gate logic
is deliberately conservative — the sensor returns null unless LSP is enabled,
writes were actually applied (not dry-run), and at least one written path passes
the file filter. It never throws; a sensor failure is silent, not fatal. The
sensor is wired at all three apply sites in `app.mjs`: standard apply, staged
apply, and subagent apply.

When diagnostics come back, they travel into `runHealingIfNeeded` as a
`diagnostics` argument alongside the test results. The healing loop now has two
signal sources: test failures (was the behaviour wrong?) and diagnostic errors
(is the code structurally broken?). A repair turn that fixes a type error before
running tests is more likely to converge in fewer turns than one that has to
infer the structural problem from a downstream test failure.

## Rendering Diagnostics for Models

`src/harness.mjs` exports `renderDiagnosticsForModel`, which takes the raw
diagnostic results and produces a prompt-friendly string. The formatting
decisions:

- Errors suppress warnings. If a file has both, only errors appear. A model
  repairing a type error does not need to know about a linting warning on the
  same file.
- Truncation at 20 diagnostics per file, 5 files total. Diagnostic floods (a
  missing import can produce hundreds of cascading errors) are useless noise in
  a repair prompt.
- Format is `path:line:col: severity: message`, one per line, with a header
  count. Simple enough that every model we test against handles it without
  confusion.

`healing.mjs` calls `renderDiagnosticsForModel` to build the diagnostic section
of each repair prompt and accepts a `diagnosticsProvider` that re-runs the
sensor after each repair turn's writes land. The provider wiring is the same
pattern used for the verification runner: a function the loop calls, not a
value it inspects once.

## The Harness Manifest

Every run now includes `summary.harness` in the JSON output. The manifest is
built by `buildHarnessManifest` in `src/harness.mjs` (zero imports, pure
functions) and wired at all four summary assembly sites. It classifies each
control along two axes from the Fowler taxonomy:

**Role:**
- *Guides* shape the model's context: repomap, file-map, LSP inspectors,
  agents-md, memory, skills, inspection-plan, session-compaction
- *Sensors* observe outcomes: json-extraction, safe-writes,
  post-write-diagnostics, dependency-install, verification, healing-loop

**Method:**
- *Computational* controls apply deterministic rules (safe-writes checks paths,
  json-extraction parses structure)
- *Inferential* controls involve judgment calls, either by the model or by
  heuristics that approximate judgment (repomap ranking, healing-loop repair
  prompts)

The manifest includes coverage counts: how many computational guides ran, how
many inferential sensors ran, and so on. `diagnostics.json` is written alongside
`tests.json` in every run, even when no diagnostics were collected (an empty
result is still a data point — it means the sensor ran and found nothing, or
was gated out).

Future phases can query `summary.harness.coverage` to know which controls were
active during a run. The phase 100 eval suite, for instance, could filter runs
by `coverage.sensors.computational >= 2` to ensure the workspace was actually
inspected before scoring it.

## Two Bugs Found During Implementation

**`performance` import in `post-write-sensor.mjs`.** An early draft had
`import { performance } from 'node:perf_hooks'` at the top, which is the
correct import for Node 18 and 20. Node 24 exposes `performance` as a global,
and importing it from `node:perf_hooks` works but triggers a lint warning
under the project's no-unnecessary-imports rule. Removed the import; the global
is used directly. Recorded in `process/failures.jsonl` as a Node version
assumption.

**`lspDiagnostics` → `diagnostics` field name mismatch.** Phase 99 attached
diagnostics to `InspectedFile` as `lspDiagnostics`. The post-write sensor
was written to read `file.diagnostics`. The sensor silently returned empty
results on every run during early testing because the field was never found.
Caught during the `post-write-sensor.test.mjs` test suite (the fixture files
had diagnostics; the sensor returned null). Fixed by aligning on `diagnostics`
as the field name and updating the phase 99 normalization path. Also recorded
in `process/failures.jsonl`.

## What This Enables

The controls were already there. Phase 101 makes them active by default,
connected to each other, and visible in output. A bare `kodr run` on a machine
with gopls installed now probes for LSP, inspects written files after apply,
feeds diagnostic errors into the healing loop if tests fail, and reports which
controls ran in `summary.harness`. The phase 100 edit eval suite has better
signal to work with. Phases 102 and beyond that tune repair pressure and routing
have a richer harness to tune against.
