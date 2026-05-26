# Phase 10: Proposal Flow

Phase 10 connects model output to the first complete local coding loop.

## Decision

Treat model responses as possible proposals, extract `{ "files": [...] }` JSON defensively, and send proposed writes through the safe-write transaction module.

## Flow

1. Run a prompt.
2. Save prompt, context, response, summary, and raw response artifacts.
3. Try to extract proposal JSON from the response.
4. Write `writes.json` for dry-run or apply results.
5. With `--yes`, apply writes and backups.
6. With `--test`, run an allowlisted verification command and write `tests.json`.

Dry-run remains the default.

## Verification

```sh
npm run format
npm test
npm run check
```
