# Phase 13: One-Shot Healing

## Goal

Repair one failed verification run without creating an unbounded loop.

## Build Steps

- [ ] Detect failed post-write tests.
- [ ] Repack fresh context.
- [ ] Include `.koder/last-test.md`.
- [ ] Ask for one repair proposal.
- [ ] Apply repair and rerun tests once.

## Done Criteria

- [ ] Tests cover a failing write repaired once.
- [ ] Tests prove no second repair loop occurs.
- [ ] Blog post documents the failure and repair path.
