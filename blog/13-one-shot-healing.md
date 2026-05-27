# Phase 13: One-Shot Healing

Phase 13 adds a single repair attempt after failed verification.

## Decision

Healing is one-shot only. If verification fails, Kodr can build a repair prompt from fresh context and `.kodr/last-test.md`, apply one proposal, and rerun the allowlisted test once.

## Why

Automatic repair loops can hide mistakes and burn time. One repair gives the model a chance to fix obvious errors while preserving a hard stop for the user to inspect.

## Verification

```sh
npm run format
npm test
npm run check
```
