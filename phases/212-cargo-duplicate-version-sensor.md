# Phase 212 — Cargo Duplicate-Version Sensor

## Goal

Complement the `lang:rust` skill pin guidance (Phase 210) with a verification step:
a `kodr check` sensor that runs `cargo tree -d` on Rust workspaces and flags crates
that appear at multiple major versions in the dependency graph. Mixing reqwest 0.11
and 0.12 (hyper 0.14 vs hyper 1.x) causes `reqwest::Client` type conflicts the
compiler rejects; the skill prevents this upfront, the sensor catches it after apply.

## Design

### Sensor contract (matches all existing cross-ref sensors)

```js
{
  sensor: 'cargo-duplicates',
  status: 'ok' | 'warn' | 'skipped',
  checked: number,          // count of duplicate crates examined
  issues: [{ sensor, path, line, message, severity }],
  message: string,
}
```

### Skip conditions

- `Cargo.toml` does not exist in `cwd` → `status: 'skipped'`
- `cargo` is not in PATH (probe with `cargo --version`, catch ENOENT) → `status: 'skipped'`, `message: 'cargo not found in PATH'`

### Implementation: `runCargoDuplicatesSensor(cwd, _paths)`

1. Check `access(join(cwd, 'Cargo.toml'))` — skip if missing.
2. Probe `cargo --version` — skip with message if ENOENT.
3. Spawn `cargo tree -d --color=never` in cwd with a 30 s timeout.
4. Parse stdout: lines starting with `[a-z][a-z0-9_-]* v\d+` are top-level entries
   (no leading tree characters). Extract `{ name, major }` pairs.
5. Group by `name`; keep groups with ≥ 2 distinct major versions.
6. Emit one issue per conflicting group:
   ```
   { sensor: 'cargo-duplicates', path: 'Cargo.toml', line: 0,
     message: `${name}: multiple major versions in dep graph (${versions.join(', ')})`,
     severity: 'error' }
   ```
7. If `cargo tree -d` exits non-zero, return `status: 'skipped'`, message with stderr.

### Parsing detail

`cargo tree -d` output format:
```
reqwest v0.11.24
└── hyper v0.14.32
reqwest v0.12.4
└── hyper v1.6.0
```
Top-level lines (no `├`, `└`, `│`, leading space, or `[`) match:
```
/^([a-z][a-z0-9_-]*) v(\d+)\.\d+/
```
Extract `name` and `major = parseInt(capture[2])`. Group by name. Flag groups
where `new Set(majors).size > 1`.

## Files to change

### `src/cross-ref-sensor.mjs`

- Add `CARGO_DUPLICATES: 'cargo-duplicates'` to `SENSOR_NAMES`.
- Add `[SENSOR_NAMES.CARGO_DUPLICATES]: 'error'` to `SENSOR_SEVERITY`.
- Implement `runCargoDuplicatesSensor(cwd, _paths)` (async, uses `node:child_process`
  `spawnSync` or `execFile` from `node:child_process`). Uses only Node.js 24 built-ins.
- Wire into `runCrossRefSensors`: add to the `Promise.all` call and include in the
  returned array.
- Do NOT include in `runCrossRefSensorsOnProposal` — it reads the full cargo tree
  from disk and requires applied writes + a real `Cargo.toml`.

### `test/cross-ref-sensor.test.mjs`

Add a suite `runCargoDuplicatesSensor` with tests:

1. Skips when `Cargo.toml` is absent (no cwd with Cargo.toml → `status: 'skipped'`).
2. Skips when `cargo` is not in PATH — mock by passing a fake execFile that throws ENOENT.
3. Returns `ok` when `cargo tree -d` reports no duplicates (mock stdout with no
   repeated crate names at different majors).
4. Returns `warn` with one issue when two major versions of the same crate appear
   (mock stdout with `reqwest v0.11.0` and `reqwest v0.12.0` as top-level entries).
5. Skips with message when `cargo tree -d` exits non-zero (mock).

Use a real temp dir with a `Cargo.toml` file for tests 3–4 so the `access` check
passes; use a mock for the `cargo` subprocess (inject the execFile function as an
option parameter `_execFile` for testability — same pattern as other subprocess
sensors if one exists, else design it cleanly).

## Done criteria

- [x] `CARGO_DUPLICATES` added to `SENSOR_NAMES` and `SENSOR_SEVERITY`.
- [x] `runCargoDuplicatesSensor` implemented and wired into `runCrossRefSensors`.
- [x] Not included in `runCrossRefSensorsOnProposal`.
- [x] Skips gracefully when no `Cargo.toml` or no `cargo` in PATH.
- [x] 5 unit tests covering skip, ok, warn, and subprocess-error cases.
- [x] All existing cross-ref-sensor tests still pass.
- [x] `npm run format && npm run check` clean.
- [x] `process/decisions.jsonl` entry added.
- [x] Blog post exists.
- [x] Roadmap entry marked done.
- [ ] Commit made.
