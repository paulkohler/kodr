# Phase 92: Isolated File-Author Subagents

Replace the shared-context implementer pass-loop with one isolated subagent per
manifest file, eliminating the window-clog problem on local models.

## Problem

`runImplementerAgent` accumulates all files in a single context. By file 4 the
context window is clogged with files 1–3, causing distillation on small models.

## Solution

When `planManifest` is set in options (from Phase 91), `runImplementerAgent`
routes to `runIsolatedFileAuthors` instead of the shared-context loop:

- **`runFileAuthorAgent`** — fresh `createBuiltinRegistry` per author; context =
  plan summary + this file's contract + sibling *export signatures* only (never
  sibling bodies). Authored file path must match the contract.
- **`runIsolatedFileAuthors`** — iterates `structuredManifest.files`, spawns one
  author each, merges proposals with the existing `mergeProposals`. Falls back
  gracefully if the manifest is absent.
- Progress events include `file-author:subagent_start/finish` per file.
- Authors are sequential (one LM Studio instance serializes anyway); the win is
  context size, not wall-clock.

## Done criteria

- [x] File-author user prompt contains sibling export signatures but not sibling
  file bodies.
- [x] `runSubagentStages` uses isolated authors when the planner emits a
  structured manifest.
- [x] Progress events include two `file-author` start/finish pairs for a
  two-file manifest.
- [x] `orchestration.json` still records the correct `implementer.manifestCount`
  and `missingFiles`.
- [x] Old tests (free-form plan, multi-pass implementer) continue to pass via
  the fallback path.
