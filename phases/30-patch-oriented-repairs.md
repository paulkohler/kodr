# Phase 30: Patch-Oriented Repairs

## Goal

Add a safer small-edit path so repair prompts can change a narrow region without regenerating an entire file.

## Scope

- [ ] Accept a patch-oriented proposal format alongside full-file proposals.
- [ ] Validate patch targets through the same safe-write and permission checks.
- [ ] Record patch artifacts in run summaries.
- [ ] Add tests for successful patches, rejected stale patches, and verification failure output.

## Done Criteria

- [ ] Tiny repairs can be represented without full-file rewrites.
- [ ] Patch application is deterministic and jailed to the workspace.
- [ ] Failed patches leave inspectable artifacts.
- [ ] Blog post documents why this was added from example-generation failures.
- [ ] Tests pass.
