# Phase 16: Replay And Model Comparison

Phase 16 makes experiments repeatable.

## Decision

Add replay parsing for existing run artifacts and a comparison helper that runs the same prompt against multiple model ids.

## Output

Comparison writes `.kodr/comparison.json` and appends metadata to `process/experiments.jsonl`.

## Why

The project is a learning repo. Replays and comparisons let model behavior be discussed from saved artifacts instead of memory.

## Verification

```sh
npm run format
npm test
npm run check
```
