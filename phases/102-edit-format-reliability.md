# Phase 102: Edit-Format Reliability

## Goal

Make edit format the dominant reliability lever: tolerant patch application that
never crashes a run, a patch-retry loop that uses free local tokens to recover
from mismatches, a new JSON-escaping-free block format for weak models, and
edit format as a model-profile field measured by the Phase 100 eval suite.

## Key Finding

NEXT.md described adding unified-diff *input* support, but the codebase never
had it. The model already uses search/replace patches (`{path, search, replace}`
in JSON). The real problem: `preparePatches` in `safe-writes.mjs` throws on
match failures, killing the entire proposal — and `healing.mjs:151` calls it
*unguarded*, so a mismatched patch in a repair turn crashes the healing loop.
Phase re-targeted accordingly.

## Design

### Tolerant patch application (`safe-writes.mjs`)

`preparePatches` stops throwing on match failures. New return shape adds
`failedPatches: [{path, reason, occurrences, search, region}]`. Security
violations (path traversal, absolute paths) still throw `SafeWriteError`.
`closestRegion(content, search)` finds the nearest similar region in the file
for the retry prompt.

### Patch retry loop (`app.mjs`)

After `prepareChanges` returns `failedPatches.length > 0`, a bounded retry
loop (default 2 turns, `--patch-retries N`) sends the model a structured
message with the failed patches and their closest regions. Retries run before
the Phase 98 approval prompt so the user sees consolidated writes. Summary
gains `patchRetries: {attempts, recoveredPaths, unresolved}`.

### New `blocks` edit format (`edit-formats.mjs`)

A JSON-escaping-free search/replace format:

    path/to/file.js
    <<<<<<< SEARCH
    old lines verbatim
    =======
    new lines
    >>>>>>> REPLACE

Parser tolerates fenced wrapping, CRLF, backtick-quoted paths. Malformed
blocks go to an errors array, never throw. Paths validated downstream by
`jailedPath`.

### Edit format as a model-profile field

`model-profiles.mjs` gains `editFormat: 'patch'|'whole'|'blocks'` (default
`'patch'`). The base contract in `context-packer.mjs` is parameterized by
format. `blocks` format downgrades `json_schema` response format to `json`
(free text must be allowed).

### Scope cuts (documented)

- Staged orchestration (`runStagedPrompt`) keeps `'patch'` format — isolated
  file-authors write whole files anyway.
- Subagent orchestration keeps `'patch'` format.
- No nested retry inside healing loop — the loop itself is the retry mechanism;
  `failedPatches` are surfaced in the next repair turn's prompt.

## Done criteria

- [ ] `preparePatches` returns `failedPatches` instead of throwing on match failures
- [ ] `closestRegion` finds nearest region for retry prompts
- [ ] `healing.mjs:151` no longer crashes on patch failures
- [ ] `src/edit-formats.mjs` created with block parser and format contracts
- [ ] Patch retry loop wired in standard `runPrompt` path
- [ ] `editFormat` field in model profiles with CLI flag and config support
- [ ] Base contract parameterized by edit format
- [ ] `blocks` format end-to-end: parse, extract, apply
- [ ] `json_schema` → `json` downgrade for `blocks` format
- [ ] Eval cases carry `editFormat` and retry stats
- [ ] Tests for all new code paths
- [ ] Blog post, process files updated
