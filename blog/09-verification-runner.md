# Phase 09: Verification Runner

Phase 09 adds a verification runner without exposing a general shell.

## Decision

Parse a small allowlist of commands and run them with `spawn(..., { shell: false })`.

## Allowlist

Supported commands:

- `npm test`
- `npm run test`
- `node --test`
- `node --check <file>`

`node --check` only accepts relative paths without `..`.

## Why

Later phases need to run checks after writes, but a model-provided shell command is too broad. The allowlist keeps verification useful while avoiding command injection as a feature.

## Verification

```sh
npm run format
npm test
npm run check
```
