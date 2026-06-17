# Phase 192: Cross-Ref Sensors on Proposals

## Motivation

The six cross-reference sensors only fire when `writeResult.applied` is true.
A `--dry-run` (or any proposal-only path) never shows sensor warnings — so a
`.env` file proposed by the model or a cyclic import in the proposal is invisible
until the write lands. Security-sensitive signals should arrive earlier.

## What this phase does

- Added `runCrossRefSensorsOnProposal(proposalFiles, opts)` to `cross-ref-sensor.mjs`.
  - Accepts `[{ path, content }]` array (from `proposal.files`).
  - Creates a temp directory, writes the proposed files there, runs three
    content-safe sensors (import-cycles, secret-in-response, secrets-at-rest),
    cleans up, and returns results with `proposalOnly: true`.
  - Skips local-import, css-selector, and compose-dockerfile: these need to resolve
    references against the real disk and would false-positive on imports/HTML/Dockerfiles
    that exist on disk but are not part of the proposal.
- Wired into `run-pipeline.mjs` (main path and subagent-stages path):
  - After the applied-write sensor block, when `!writeResult.applied && proposal.files.length > 0`.
  - Results stored as `summary.proposalSensors`.

## Design decisions

- **Temp dir approach** over a virtual FS or content-map augmentation: avoids
  modifying individual sensor signatures; new sensors automatically benefit.
- **Apply-only sensors explicitly excluded**: documented in function JSDoc and
  phase file. The tradeoff (false positive risk vs wider coverage) is intentional.
- **`proposalOnly: true`** marker: lets callers display proposal results separately
  from post-apply results without field-name collision.

## Done criteria

- [x] `runCrossRefSensorsOnProposal` exported from `cross-ref-sensor.mjs`.
- [x] 7 unit tests covering: empty input, disabled, .env detection, cycle detection,
  proposalOnly marker, clean content, missing content.
- [x] Wired into main pipeline path and subagent-stages path.
- [x] `summary.proposalSensors` verified in Kodr integration test.
- [x] Tests pass.
- [x] Committed.
