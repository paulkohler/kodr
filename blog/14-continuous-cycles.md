# Phase 14: Continuous Cycles

Phase 14 adds a bounded repeated-cycle primitive for local model experiments.

## Decision

Represent cycles as an explicit bounded loop that creates per-cycle artifact directories and repacks context each time.

## Stop Markers

Cycles stop early when output includes:

- `DONE`
- `NO_CHANGES`
- `KODR_STOP`

## Why Bounded Autonomy

Continuous operation is useful only when it is visibly bounded. A cycle count and explicit stop markers make repeated work inspectable and interruptible.

## Verification

```sh
npm run format
npm test
npm run check
```
