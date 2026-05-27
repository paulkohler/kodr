# Phase 13: One-Shot Healing

## Goal

Repair one failed verification run without creating an unbounded loop.

## Build Steps

- [x] Detect failed post-write tests.
- [x] Repack fresh context.
- [x] Include `.kodr/last-test.md`.
- [x] Ask for one repair proposal.
- [x] Apply repair and rerun tests once.

## Done Criteria

- [x] Tests cover a failing write repaired once.
- [x] Tests prove no second repair loop occurs.
- [x] Blog post documents the failure and repair path.
