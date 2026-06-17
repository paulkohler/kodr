# Phase 194: Bridge `kodr check` Findings Into a Fix Run

## Motivation

`kodr check` is purely diagnostic: it surfaces unresolved imports, missing
Dockerfiles, and import cycles, but leaves the developer to translate those
findings into a repair prompt manually. The structured data is already there;
a `--fix` flag can turn it directly into a scoped repair task for the local model.

## What this phase does

- Added `--fix` flag to `kodr check`. When set and issues are found, `runCheck`
  synthesises a `buildFixPrompt` result and returns a `fixPrompt` string instead
  of normal output, then the dispatcher in `app.mjs` routes that into `runPrompt`.

- `buildFixPrompt(checkResult)` constructs a targeted prompt:
  - Syntax failures → "syntax error in <file>: <message>"
  - Sensor warns → "<sensor> in <loc>: <detail>" (import path, dockerfile context,
    cycle path, or secret leak as appropriate)
  - Prefix: "Address only the listed issues. Do not refactor or change unrelated code."
  - Returns `null` when there are no issues — no spurious model calls.

- `app.mjs` check dispatch: if `checkResult.fixPrompt` is set, builds `fixOptions`
  with `{ ...options, command: 'run', prompt: fixPrompt, yes: true }` and calls
  `runPrompt`, so writes are applied just like a regular `kodr run`.

- `--fix` with `--json` suppresses the "passing findings to model…" banner (stdout
  would corrupt structured output).

## Known limitations

- `--fix` always applies writes (`yes: true`). There is no `--fix --dry-run`
  combination yet; pass `--dry-run` as a separate flag if needed (it flows through
  `fixOptions` via the spread).
- `buildFixPrompt` does not include warning-severity sensors that lack `issues`
  arrays (e.g. compose-dockerfile when no issues sub-array is present). This is
  conservative — better to fix only actionable items.

## Done criteria

- [x] `--fix` flag added to `args.mjs` defaults and parser.
- [x] `buildFixPrompt` implemented in `check.mjs`.
- [x] `runCheck` returns `{ fixPrompt }` when issues found and `--fix` set.
- [x] `app.mjs` routes `fixPrompt` into `runPrompt`.
- [x] 4 new tests in `test/check-command.test.mjs` (`runCheck --fix` describe).
- [x] `npm run format` passes.
- [x] Tests pass.
- [x] Kodr integration test.
- [x] Committed.
