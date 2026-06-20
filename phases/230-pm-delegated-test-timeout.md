# Phase 230 — Per-test timeout for package-manager-delegated `node --test` verification

## Motivation

kodr bounds per-test hangs by appending `--test-timeout` to `node --test`, but
**only** when the verification command parses as a *direct* `node --test`
invocation. `runVerification` in `src/verification-runner.mjs` (the `effective`
rewrite, ~lines 143–150) gates on `parsed.bin === 'node' &&
parsed.args.includes('--test')`. When the command is `npm test` / `pnpm test` /
`yarn test` — which `detectTestCommand` returns whenever `package.json` has a
`scripts.test` — the package-manager script delegates to `node --test` *without*
the per-test bound. A single hanging generated test then runs until the coarse
outer `timeoutMs` kills the whole suite.

**Observed (final-audit dogfood, `final-audit/blog-platform`):** the generated
`package.json` test script was a bare `node --test`, the auto-detected command
was `npm test`, and one generated test (a leaked HTTP connection / unresolved
await in a pagination test — a sibling handler referenced an out-of-scope
`params`, so the response never sent) hung ~300s, consuming the run and
triggering a doomed heal turn. The harness's own suite already uses
`--test-timeout=60000`; this phase extends an equivalent per-test bound to the
package-manager-delegated path so one hung generated test fails fast.

## Decision: mechanism

Three options were weighed (see `process/decisions.jsonl`):

- **(a) Forward args via `npm test -- --test-timeout=<N>`** — REJECTED as unsafe.
  `npm test [-- <args>]` does forward args (npm 11.x), but `--test-timeout` is an
  invalid flag for a non-`node --test` script (jest/mocha/vitest) and would turn
  a working verification into a hard failure. Making it safe requires reading
  `scripts.test` first — at which point option (b) is cleaner. pnpm/yarn `--`
  forwarding also varies across versions.
- **(c) Env var** — REJECTED, does not exist. Node 24's test runner exposes the
  per-test timeout *only* as the `--test-timeout=` CLI flag; there is no
  `NODE_TEST_TIMEOUT`.
- **(b) Scoped command rewrite** — CHOSEN. When (and only when) `package.json`
  exists and its `scripts.test`, trimmed, **is** a bare `node --test`
  (optionally already carrying `--test-timeout=`), rewrite the spawned command to
  `node --test` and let the *existing* injection add `--test-timeout`. This
  mirrors the precedent already in `resolveVerificationCommand` (npm→node when
  package.json is absent). Safest (a non-`node --test` script is never touched),
  most deterministic (no `--` forwarding across three package managers), smallest
  (reuses the existing injection path).

**Matcher (qualify a script for rewrite):** `script.trim().split(/\s+/u)` must be
`node --test` with at most extra `--test-timeout=<digits>` flags and nothing
else — `parts[0] === 'node' && parts[1] === '--test'` and every part at index ≥2
matches `/^--test-timeout=\d+$/u`. Anything else (a test-file path, other flags,
`&&` chains, jest/mocha/vitest) → leave as `<pm> test`, today's behavior. Strip
any pre-existing `--test-timeout=` so the injection adds exactly one.

## Where the change lives

`runVerification` **only** (the `effective` computation) plus one new
module-scope helper. The package-manager→node decision must read `package.json`
(async/IO), so it cannot live in the pure sync allowlist `parseVerificationCommand`.
`runVerification`'s `effective` block is the single chokepoint every caller
(orchestration, run-pipeline, healing, tool-calls, eval) funnels through, so the
bound is applied uniformly there rather than in `resolveVerificationCommand`
(which only one caller invokes).

**Allowlist / no-shell safety:** the rewrite produces the literal
`{ bin: 'node', args: ['--test', '--test-timeout=<N>'] }` — identical to what
`parseVerificationCommand('node --test')` yields. No script/user/model string is
interpolated into `args`; the script is read only to *decide whether* to rewrite,
never to *build* spawn args. `spawn(..., { shell: false })` is unchanged.

## Work items

- [x] Add async module-scope helper `nodeTestScript(cwd)` to
  `src/verification-runner.mjs` (near `packageJsonHasTestScript`): read
  `package.json` (same `try/JSON.parse/catch` shape), inspect `scripts.test`,
  apply the matcher above, return `{ bin: 'node', args: ['--test'] }` on qualify
  else `null`. Parse failure / missing → `null` (fail safe to today's behavior).
- [x] Rewrite the `effective` computation in `runVerification` (after the
  `needsPackageJson` package.json-presence guard): compute `base` = the scoped
  rewrite when `needsPackageJson && await nodeTestScript(cwd)` is non-null, else
  `parsed`; then apply the **existing, unchanged** `--test-timeout` injection to
  `base`. Add a comment cross-referencing the failures.jsonl entry.
- [x] Keep the raw `command` string unchanged so `hasRequiredTestCoverage` and
  the summary still see `npm test`.
- [x] Keep `testTimeoutMs` default at 10000; no new caller wiring, no other
  default changed.
- [x] Add `node:test` cases to `test/verification-runner.test.mjs` (match the
  injected-`runner` stub style):
  1. `npm test` with `scripts.test: 'node --test'` → rewrites to `node --test`
     with `--test-timeout=`.
  2. `pnpm test` and `yarn test` with a bare `node --test` script → same.
  3. `testTimeoutMs` honored on the pm rewrite path (e.g. 5000).
  4. `scripts.test: 'jest'` → stays `{ bin: 'npm', args: ['test'] }`, no
     `--test-timeout` (the safety guarantee).
  5. `scripts.test: 'node --test test/*.mjs'` (extra path) → not rewritten.
  6. `scripts.test: 'node --test --test-timeout=999'` + `testTimeoutMs: 7000` →
     exactly one `--test-timeout=7000`, no duplicate.
  7. Allowlist intact: `parseVerificationCommand('npm test && rm -rf .')` still
     throws `VerificationError` (rewrite is post-parse).
- [x] Confirm the existing direct-`node --test` injection tests pass unchanged.
- [x] `npm run format`, run tests, `npm run check`.
- [x] `process/decisions.jsonl`: record the (b)-over-(a)/(c) decision with the
  verified npm/Node semantics.
- [x] `process/failures.jsonl`: append a phase-230 entry cross-referencing
  `final-audit-dogfood` (symptom, root cause at the `effective` gate, fix).
- [x] `blog/230-pm-delegated-test-timeout.md`: "The timeout we shipped, and the
  door we left open" — the bound from an earlier phase had a blind spot exactly
  one indirection deep.
- [x] `roadmap.md`: append `- [x] 230 Per-test timeout for
  package-manager-delegated node --test verification`.
- [x] `package.json`: bump `0.0.229` → `0.0.230` (`cversion --check` couples it
  to the max checked roadmap phase).
- [x] `NEXT.md`: FIFO-delete the shipped "Heal/test hang" candidate; update the
  frontier note to 230.
- [x] Commit.

## Must NOT change (regression guard)

- Direct `node --test` / `node --test <file>` injection behavior (byte-identical).
- `parseVerificationCommand` stays pure/sync/IO-free; injection-shaped commands
  still throw.
- `detectTestCommand` still returns `npm test`/`pnpm test`/`yarn test`.
- `resolveVerificationCommand` still rewrites npm→node only when package.json is
  absent.
- The `needsPackageJson` early-return guard runs first, unchanged.
- `hasRequiredTestCoverage` still keys on the raw `command`.
- `spawn(..., { shell: false })` and env-stripping unchanged.
- `testTimeoutMs` default stays 10000.
