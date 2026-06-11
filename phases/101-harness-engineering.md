# Phase 101: Harness Engineering — Opinionated Sensors

## Goal

Make kodr's harness controls visible, on by default, and wired into the healing loop — implementing the Fowler/Böckeler "keep quality left" principle by defaulting LSP integration to 'auto', adding a post-write diagnostic sensor, feeding diagnostics into repair prompts, and reporting a structured harness manifest in every run summary.

## Motivation

Phase 99 added LSP as an opt-in capability. This phase flips the default: LSP probes for available servers automatically, post-write diagnostics re-inspect changed files before tests run, and the healing loop sees diagnostic errors alongside test failures. The harness manifest (summary.harness) classifies every control as a guide or sensor, computational or inferential, following Martin Fowler's Harness Engineering taxonomy.

## Changes

### LSP tri-state default
- `app.mjs`: `lsp` default changed from `false` to `'auto'`
- `external-inspector-registry.mjs`: `lspEntryAllowed` handles `'auto'` explicitly
- `project-config.mjs`: validation and display support `'auto'` as a first-class value

### New modules
- `src/harness.mjs` — pure-function harness manifest builder (`buildHarnessManifest`) and LLM-friendly diagnostic renderer (`renderDiagnosticsForModel`). Zero imports.
- `src/post-write-sensor.mjs` — re-inspects changed files via LSP after writes land. Gate logic: returns null unless LSP is enabled, writes were applied, and at least one path passes filtering. Never throws.

### Sensor + healing wiring
- `app.mjs`: `runPostWriteDiagnostics` called at all three apply sites (standard, staged, subagent). Results passed through `runHealingIfNeeded` → `runSelfHealingLoop` as `diagnostics`.
- `healing.mjs`: accepts `diagnostics` and `diagnosticsProvider` options. Diagnostics rendered into repair prompts via `renderDiagnosticsForModel`. Provider re-runs diagnostics after each repair turn's writes land.
- `diagnostics.json` artifact written alongside `tests.json` in every run.

### Harness manifest
- `buildHarnessManifest` wired into `summary.harness` at all four summary assembly sites.
- Classifies: repomap, file-map, LSP inspectors, agents-md, memory, skills, inspection-plan, session-compaction as **guides**; json-extraction, safe-writes, post-write-diagnostics, dependency-install, verification, healing-loop as **sensors**.
- Coverage counts: computational/inferential × guide/sensor.

## Done criteria

- [x] `lsp` defaults to `'auto'` in app.mjs
- [x] `lspEntryAllowed` handles `'auto'` in external-inspector-registry.mjs
- [x] project-config validates and displays `'auto'`
- [x] `src/harness.mjs` created with `buildHarnessManifest` and `renderDiagnosticsForModel`
- [x] `src/post-write-sensor.mjs` created with `inspectChangedFiles` and `runPostWriteDiagnostics`
- [x] Post-write sensor wired at standard, staged, and subagent apply sites
- [x] Diagnostics passed into healing loop and rendered in repair prompts
- [x] `diagnostics.json` artifact written in all code paths
- [x] `summary.harness` manifest wired at all four summary sites
- [x] `test/harness.test.mjs` — 49 tests passing
- [x] `test/post-write-sensor.test.mjs` — 22 tests passing
- [x] Existing tests updated and passing (210 total across affected files)
- [x] `npm run format` clean
