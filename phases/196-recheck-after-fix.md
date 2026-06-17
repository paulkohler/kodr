# Phase 196: Auto-Recheck After `kodr check --fix`

## Motivation

Phase 194/195 shipped `kodr check --fix` — but after the model applies the fix,
the user had no idea whether it actually worked. The flow went silent after
"passing findings to model…". You had to manually re-run `kodr check` to confirm.

## What this phase does

After `runPrompt` returns from the fix run, the `check` dispatcher in `app.mjs`
runs `runCheck({ ...options, fix: false }, checkIo)` a second time:

1. Prints `kodr check --fix: re-checking after fix…`
2. Runs the full check on the now-modified workspace
3. Returns the re-check result as the command result (exit code reflects the
   post-fix state, not the pre-fix state)

`fix: false` in the re-check options prevents any loop (if the check still fails,
it reports failure but does not trigger another fix round).

`--json` suppresses the re-check banner since structured output consumers do not
expect extra text between JSON blocks.

## Done criteria

- [x] `app.mjs` dispatch: re-check after fix with `fix: false`.
- [x] Re-check banner printed (unless `--json`).
- [x] 1 new test: `fix:false never returns fixPrompt even when issues exist`.
- [x] `npm run format` passes.
- [x] Tests pass.
- [x] Kodr integration test: re-check banner visible; post-fix check passes clean.
- [x] Committed.
