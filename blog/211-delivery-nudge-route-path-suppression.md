# Phase 211: deliveryNudge Route-Path False Positive Suppression

## The remaining false positive after Phase 208

Phase 208 fixed the deliveryNudge phantom file problem in two steps: strip fenced
code blocks before scanning, and require bare names (no `/`) to be at line start.
That eliminated `test.txt`, `files/test.txt` from code examples, and bare module
names mid-sentence.

But one false positive survived: route descriptions in test bullet lists.

```
- POST /files/test.txt — upload endpoint
- GET /api/v1/status.json — health check
```

The regex extracts `files/test.txt` from `POST /files/test.txt` because:
1. `/` is not a word character, so the `(?<!\w)` lookbehind passes
2. `files/test.txt` contains a `/`, so the unconditional "path with directory
   separator" rule fires

The nudge turn fires, the model can't write a URL route so `recovered: []`, and
the wasted turn costs latency and tokens on every affected run.

## The fix

One guard added to the loop body in `extractPromptFilePaths`:

```js
// Skip URL path components — a preceding '/' means absolute route, not workspace path.
if (m.index > 0 && stripped[m.index - 1] === '/') continue;
```

If the character immediately before the match is `/`, the token is a component of an
absolute URL path — not a workspace-relative file path. Workspace-relative paths in
bullet lists never have `/` immediately before them.

The fix cannot produce false negatives on real file paths. A bullet entry like
`- src/files/test.txt` has `- ` before `src`, not `/`. A path like `api/v1/upload.json`
at line start is unaffected for the same reason.

## Test coverage

Three new tests added to the `extractPromptFilePaths (Phase 139)` suite:

1. `GET /files/test.txt` and `POST /api/v1/upload.json` — neither component extracted
2. `src/files/test.txt` and `api/v1/upload.json` in a bullet list — both extracted
   (no preceding `/`)

All 10 extractPromptFilePaths tests pass.
