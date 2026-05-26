# Phase 15: Local Bin Install

Phase 15 makes Kodr easier to run from any directory.

## Decision

Add `npm run install-local` to write a small shell shim into `~/.local/bin/koder` by default.

## Options

The installer supports:

- `--dir`
- `--name`

Tests install into a temporary bin directory and verify `--version`.

## Verification

```sh
npm run format
npm test
npm run check
```
