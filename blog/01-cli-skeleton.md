# Phase 01: CLI Skeleton

The initial CLI only supports help, version, and local-model defaults.

## Decision

Add a boring executable before adding model calls.

## Why

The harness should have a stable command surface before it talks to LM Studio.

## Verification

```sh
npm test
./koder --help
```
