# Phase 08: Safe Writes And Diffs

Phase 08 turns proposed file changes into controlled transactions.

## Decision

Add a reusable safe-write module before connecting model output to the filesystem.

## Design

The module rejects absolute paths, `..` segments, and symlink parents. Dry runs produce simple before/after diffs without modifying files. Apply mode writes files and stores timestamped backups for existing files under `.koder/backups/`.

## Why Model Writes Are Untrusted

Model output is text from an untrusted source. Even if a later phase extracts valid JSON, paths and contents must still pass a workspace jail before any write happens.

## Verification

```sh
npm run format
npm test
npm run check
```
