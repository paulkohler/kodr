# Phase 196: Auto-Recheck After `kodr check --fix`

`kodr check --fix` was silent after applying the model's repair. You'd see
"passing findings to model…" and then nothing — you had to run `kodr check` again
yourself to confirm it worked.

Phase 196 closes the loop.

## Before (Phase 194/195)

```
⚠ local-import: 1 unresolved local import
check passed

kodr check --fix: passing findings to model…
(model applies fix, exits)
```

## After (Phase 196)

```
⚠ local-import: 1 unresolved local import
check passed

kodr check --fix: passing findings to model…

kodr check --fix: re-checking after fix…

kodr check
  workspace: /path/to/project

✔ local-import: 2 files ok — all local imports resolve
2 files · 4 sensors

check passed
```

The re-check runs `kodr check` with `fix: false` so a still-broken workspace
reports failure without triggering another model call. The exit code reflects
the post-fix state.

`--json` output suppresses the banner to avoid corrupting structured output for
scripts that consume `kodr check --fix --json`.

## Kodr integration test

`~/src/kodr-testing/phase-196/recheck-after-fix/`:

- `main.mjs` imports `./processor.mjs` (missing)
- `kodr check --no-smoke --fix` → model creates `processor.mjs`
- Re-check runs automatically: `2 files · 4 sensors`, `check passed`
