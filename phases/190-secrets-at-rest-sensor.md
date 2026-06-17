# Phase 190: Secrets-at-Rest Sensor

## Motivation

The existing `secret-in-response` sensor (phase 173) catches credentials
reaching serialisation sinks. It does NOT catch credentials that live in the
write set as committed artifacts: a `.env` file committed by the model, or a
hardcoded `API_KEY = 'sk-live-...'` in source code. The hook/CI direction makes
this gap important — the pre-commit hook should catch committed secrets before
they land in version control.

## What this phase does

- Added `SECRETS_AT_REST = 'secrets-at-rest'` to `SENSOR_NAMES` (now 6 sensors).
- Added `SENSOR_SEVERITY[SECRETS_AT_REST] = 'error'` (security-critical).
- Implemented `scanSecretsAtRest(content)`: scans JS source for
  `const/let/var SECRET_NAME = 'long-string-literal'` where:
  - Variable name contains `password|secret|api_key|credential|private_key` etc.
  - Assigned value is ≥ 24 chars, no whitespace, not a placeholder.
  - Suppressed by `// kodr-ignore: secrets-at-rest` on the same line.
- Implemented `runSecretsAtRestSensor(cwd, writePaths)`:
  - Flags `.env` files in the write set (but not `.env.example/.env.sample`).
  - Scans JS files for hardcoded credentials via `scanSecretsAtRest`.
- Wired into `runCrossRefSensors` as the 6th sensor.

## Known limitations

- The JS credential heuristic requires the variable name to contain a known
  sensitive term. Generic `STRIPE_KEY` or `OPENAI_KEY` are not flagged — only
  `API_KEY`, `SECRET`, `CREDENTIAL`, `PASSWORD`, etc. This is intentional to
  keep false positives low. The name+shape heuristic (not pure entropy) is the
  primary signal.
- High-entropy detection (pure entropy threshold) was considered but rejected
  as too noisy without name context.

## Done criteria

- [x] 6th sensor in `SENSOR_NAMES` and `SENSOR_SEVERITY`.
- [x] `scanSecretsAtRest` exported and tested (5 unit tests).
- [x] `runSecretsAtRestSensor` exported and tested (5 integration tests).
- [x] Wired into `runCrossRefSensors`.
- [x] `sensorRegistry` length updated from 5 → 6 in tests.
- [x] Kodr test: `.env` file flagged as `secrets-at-rest` warn; `--strict` fails.
- [x] Tests pass.
- [x] Committed.
