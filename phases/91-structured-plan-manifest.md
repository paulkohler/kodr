# Phase 91: Structured Plan Manifest

Upgrade the planner from free-form prose to a structured JSON manifest so
downstream agents receive typed interface contracts.

## Problem

`extractPlanManifest` uses regex on free-form text to extract file paths. It
cannot capture export signatures or import dependencies, so file-author agents
have no interface contracts to work from.

## Solution

- `plannerResponseFormat()` in `structured-output.mjs` — JSON schema for
  `{ summary, files: [{ path, responsibility, exports, imports }], verification }`.
  Stripped for local+tools providers per `shouldOmitResponseFormat`, so it is
  also instructed in the planner SKILL.md body text.
- `parsePlanManifest(text)` in `orchestration.mjs` — extracts the structured
  manifest from the planner's text output via `extractJson`; returns `null` on
  failure so the old regex path remains the fallback.
- `runPlannerAgent` now returns `{ plan, manifest }` and writes `manifest.json`
  when a structured manifest is parsed.
- `runSubagentStages` passes `planManifest: planner.manifest` to the implementer
  options.

## Done criteria

- [x] `parsePlanManifest` parses structured manifests and returns null for
  free-form text.
- [x] `runPlannerAgent` populates `manifest` when the response contains JSON.
- [x] Legacy free-form plan responses still work (manifest is null, fallback
  active).
- [x] `orchestration.json` includes `planner.manifestFiles`.
