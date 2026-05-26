# Phase 27: Patch-Oriented Repairs

## Goal

Add a safer small-edit path so repair prompts can change a narrow region without regenerating an entire file.

## Scope

- [x] Accept a patch-oriented proposal format alongside full-file proposals.
- [x] Validate patch targets through the same safe-write and permission checks.
- [x] Record patch artifacts in run summaries.
- [x] Add tests for successful patches, rejected stale patches, and verification failure output.

## Done Criteria

- [x] Tiny repairs can be represented without full-file rewrites.
- [x] Patch application is deterministic and jailed to the workspace.
- [x] Failed patches leave inspectable artifacts.
- [x] Blog post documents why this was added from example-generation failures.
- [x] Tests pass.
