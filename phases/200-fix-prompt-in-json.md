# Phase 200: Include fixPrompt in kodr check --json Output

## Motivation

`kodr check --json` was the only output mode that couldn't expose the repair
prompt. To drive a fix from JSON output, a caller would need to:
1. Run `kodr check --json` to get issue details
2. Manually construct the repair prompt
3. Pass it to `kodr run`

Now `fixPrompt` is included directly in the JSON when there are fixable issues,
enabling clean pipelines:
```sh
kodr check --json | jq -r '.fixPrompt // empty' | kodr run --prompt-file /dev/stdin
```

## What this phase does

In `runCheck`, before writing the JSON output, `buildFixPrompt(checkResult)` is
called. If it returns a non-null string, the result is added as `jsonOut.fixPrompt`.

The field is omitted when the check is clean (null from `buildFixPrompt`), so
consumers can use `.fixPrompt // empty` idiom safely.

`--fix` mode is unchanged — `fixPrompt` in JSON does not trigger a model call.
That still requires `--fix` explicitly.

## Done criteria

- [x] `buildFixPrompt` called for JSON path in `runCheck`.
- [x] `fixPrompt` included in `jsonOut` when non-null.
- [x] `fixPrompt` absent in JSON when check is clean.
- [x] 2 new tests: `--json includes fixPrompt when sensor issues exist`;
      `--json omits fixPrompt when check is clean`.
- [x] `npm run format` passes.
- [x] Tests pass.
- [x] Verified: `kodr check --json` on broken workspace includes `fixPrompt`.
- [x] Committed.
