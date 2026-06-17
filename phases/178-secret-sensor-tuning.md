# Phase 178: Secret Sensor Safe-Names Allowlist + `// kodr-ignore`

## Motivation

Phase 173 introduced the secret-in-response sensor. In practice it fires too
aggressively on legitimate OAuth flows: returning `accessToken` or `refreshToken`
to the client is correct and expected, not a leak. Two suppressors are needed:

1. A **safe-names allowlist** so common OAuth/CSRF tokens are not flagged.
2. A **per-block suppression comment** (`// kodr-ignore: secret-in-response`) for
   cases the allowlist cannot cover.

## What this phase does

**`src/cross-ref-sensor.mjs`**:
- `SAFE_SECRET_NAMES` regex — covers `accessToken`, `refreshToken`, `idToken`,
  `csrfToken`, `bearerToken`, `authToken`, `xCsrf` (and their snake_case forms).
- `IGNORE_COMMENT` regex — matches `// kodr-ignore: secret-in-response` anywhere
  in the ±4-line window.
- `scanSecretLeaks` updated: (1) skip window when `IGNORE_COMMENT` matches;
  (2) after `SECRET_NAMES` matches, strip `SAFE_SECRET_NAMES` tokens and re-test —
  only flag if a non-safe secret name remains.

**`test/cross-ref-sensor.test.mjs`** — 5 new tests:
- `accessToken` near `res.json` → no hit.
- `refreshToken` near `res.json` → no hit.
- `password` + `accessToken` → still flags (non-safe name survives the strip).
- `// kodr-ignore: secret-in-response` on sink line → suppressed.
- `// kodr-ignore` appearing anywhere in window → suppressed.

## Done criteria

- [x] `accessToken` and `refreshToken` are not flagged.
- [x] `password` still triggers even alongside safe names.
- [x] `// kodr-ignore: secret-in-response` suppresses a hit.
- [x] 69 tests in cross-ref-sensor.test.mjs pass.
- [x] format + check clean; decisions logged; roadmap checked; version bump; committed.
