# Phase 211 — deliveryNudge Route-Path False Positive Suppression

## Goal

Phase 208 eliminated phantom file writes from the deliveryNudge by stripping fenced
code blocks and requiring bare names to appear at line start. One false positive
remains: paths like `files/test.txt` extracted from route descriptions such as
`GET /files/test.txt`. The nudge fires an extra model turn for these strings, but
`recovered: []` every time because the model can't write a file that is actually a
URL route. The wasted turn adds latency and tokens on every affected run.

The root cause is the catch-all rule for paths containing `/`: any token matching
`[a-z][\w./-]*\.[a-z]{1,6}` with a `/` in it is accepted unconditionally. When the
regex matches `files/test.txt` from `/files/test.txt`, the preceding `/` is not a
word character so the `(?<!\w)` lookbehind passes.

Fix: if the character immediately before the match is `/`, the token is a component
of an absolute URL path — skip it.

## Changes

### `src/run-pipeline.mjs`

In `extractPromptFilePaths`, after the `:` / `^\d` guard, add:

```js
// Skip URL path components — preceded by '/' means absolute route, not workspace path.
if (m.index > 0 && stripped[m.index - 1] === '/') continue;
```

### `test/app.test.mjs`

Add three tests to the `extractPromptFilePaths (Phase 139)` suite:

1. Route-method path — `GET /files/test.txt` does not extract `files/test.txt`
2. Nested route — `POST /api/v1/upload.json` does not extract `api/v1/upload.json`
3. No false negative — `src/files/test.txt` in a bullet still extracted (starts a
   line, not preceded by `/`)

## Done criteria

- [x] `extractPromptFilePaths` skips paths preceded by `/`.
- [x] Three new tests pass.
- [x] All existing `extractPromptFilePaths` tests still pass.
- [x] `npm run format && npm run check` clean.
- [x] `process/decisions.jsonl` entry added.
- [x] Blog post exists.
- [x] Roadmap entry marked done.
- [x] Commit made.
