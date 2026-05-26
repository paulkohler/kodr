# Phase 12: Workflow Mode

Phase 12 sketches staged workflow coordination without adding more model calls yet.

## Decision

Represent workflow stages and reviewer path checks as deterministic local data first.

## Stages

- Planner
- Coder
- Senior Reviewer
- Writer
- Tester
- Documenter
- Reporter

The reviewer receives the plan and proposed paths. Any proposal that touches an unplanned path is rejected.

## Why Batch-Aware Review

Coding proposals often change multiple files. Reviewing only one file at a time misses path-level surprises, so the reviewer must see the whole planned batch before approval.

## Verification

```sh
npm run format
npm test
npm run check
```
