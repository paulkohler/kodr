# Phase 212: Cargo Duplicate-Version Sensor

## The problem this solves

Phase 210 added a `lang:rust` builtin skill that pins reqwest 0.12 and
encodes the correct hyper 1.x dependency. The skill tells the model what to
write. But it can't verify what the model actually wrote after apply.

The specific failure mode: a Rust workspace where two crates pull in different
major versions of hyper — one via reqwest 0.11 (hyper 0.14) and one via reqwest
0.12 (hyper 1.x). The compiler sees `hyper::Body` as two distinct, incompatible
types. The error is non-obvious and only appears at the linkage boundary.

`cargo tree -d` surfaces this directly: it lists every crate that appears more
than once in the dependency graph. Top-level lines (no leading tree characters)
show the duplicate roots.

## Sensor design

The sensor follows the existing cross-ref pattern exactly: skip, ok, or warn.

Skip conditions:
- No `Cargo.toml` in `cwd` — not a Rust workspace
- `cargo` not in PATH — `ENOENT` on the probe call → skip with message

When it runs:
1. `access(join(cwd, 'Cargo.toml'))` — fails fast if not Rust
2. `cargo --version` probe — ENOENT → skip, other errors → still try
3. `cargo tree -d --color=never` with a 30 s timeout
4. Parse top-level lines matching `/^([a-z][a-z0-9_-]*) v(\d+)\./`
5. Group by name; flag any group with `new Set(majors).size >= 2`

The key parsing decision: `cargo tree -d` uses box-drawing characters (`└──`,
`├──`, `│`) for the tree. Top-level roots have no leading whitespace or tree
characters. The filter is a single regex on the first character.

## The semver major question

The first version of the test fixture used `reqwest v0.11.24` vs `reqwest v0.12.4`
as the two conflicting entries. That's wrong.

The regex captures the first digit group from `v(\d+)\.`. For `v0.11.24` that's
`0`. For `v0.12.4` that's also `0`. They're the same semver major — no conflict
detected.

The actual conflict `cargo tree -d` surfaces is at the level of the *indirect*
dependency that differs by major: `hyper v0.14.32` vs `hyper v1.6.0`. Those are
major `0` and major `1` — two distinct values, correctly detected.

The test fixture was updated to use `hyper v0.14.32` and `hyper v1.6.0` as
top-level entries. This matches what a real `cargo tree -d` run shows when
reqwest 0.11 and 0.12 are both present.

## Testability without cargo

Subprocess calls are hard to test without the actual binary. The sensor accepts
an `_execFile` option that replaces the real `promisify(execFile)` call. Five
unit tests:

1. Skips when no `Cargo.toml` exists in cwd
2. Skips when the mock throws `ENOENT` on `cargo --version`
3. Returns `ok` with no duplicate majors in the mocked output
4. Returns `warn` with one issue when `hyper v0.14.32` and `hyper v1.6.0` both appear
5. Skips when `cargo tree -d` exits non-zero (error thrown by mock)

No live cargo calls. The fake server pattern from the rest of the test suite.

## Not in runCrossRefSensorsOnProposal

The proposal sensor runs on proposed (not-yet-written) files in a tmp directory.
`cargo tree -d` reads the full Cargo workspace on disk — it needs the real
`Cargo.toml` and `Cargo.lock`, not a tmp directory with one proposed file.
Including it in the proposal pass would always skip (no `Cargo.toml` in tmp),
which wastes a sensor slot and could confuse callers.

Applied-writes-only is correct for this sensor.

## Existing test breakage

One existing test checked that `SENSOR_NAMES` exports exactly seven names:

```js
assert.equal(names.length, 7);
```

Adding `CARGO_DUPLICATES` made it eight. Updated to:

```js
assert.equal(names.length, 8);
assert.ok(names.includes('cargo-duplicates'));
```

Predictable fix — the test was explicitly counting the registry size rather than
asserting membership, which means any new sensor would break it. Worth keeping
the count assertion so future phases don't silently omit a sensor from the
registry.
