# Phase 197: `kodr hook status --json`

## Motivation

`kodr hook status` was the only hook subcommand without structured output.
Scripts and CI pipelines had to parse text like "pre-commit hook: installed by kodr"
to determine hook state, which is brittle. The `--json` flag was already globally
parsed and available in `options`, it just wasn't used in `runHookStatus`.

## What this phase does

`runHookStatus` now checks `options.json`. When set:
- Emits `JSON.stringify(result, null, 2)` instead of the text lines
- `result` contains `ok`, `command`, `hookStatus`, `hookStatuses`,
  and `hookPath` (when the pre-commit hook is present)
- No text lines are written (the two paths are mutually exclusive)

The text path (`renderStatus` calls) is unchanged.

## Done criteria

- [x] `runHookStatus` respects `options.json`.
- [x] 2 new tests: `--json emits structured JSON with hookStatuses`;
      `--json emits valid JSON even when no hooks installed`.
- [x] `npm run format` passes.
- [x] Tests pass.
- [x] `kodr hook status --json` verified in the project root (no hooks installed).
- [x] Committed.
