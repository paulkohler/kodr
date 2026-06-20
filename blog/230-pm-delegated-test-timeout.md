# Phase 230: Per-test timeout for package-manager-delegated node --test verification

The timeout we shipped, and the door we left open.

## The hang

The ambitious final-audit dogfood (`final-audit/blog-platform`) failed honestly:
ok:false, two heal turns, no-progress-exhausted, a heap of correctly diagnosed
systemic failures at the model's limit. Among those failures, one was a harness
blind spot, not a model defect: the pagination test hung for 303 seconds.

The generated `handleListPosts` handler referenced `params` — a `const` scoped to
the outer `route()` function — from a sibling handler. The server response never
sent, the HTTP connection leaked, and the test waiting for that response waited
forever. `node --test` has no default per-test timeout, so the test ran until
kodr's outer verification timeout killed the process. One bad test held the entire
suite hostage for five minutes.

The harness's own test suite already defends against this: `package.json` runs
`node --test --test-timeout=60000`. And `runVerification` injects `--test-timeout`
when the command parses as `node --test`. So the defense existed — it just didn't
reach the path that actually ran.

## The gap

The injection gate in `runVerification` checked:

```js
parsed.bin === 'node' && parsed.args.includes('--test')
```

When the verification command is `npm test` (or `pnpm test`, `yarn test`),
`parsed.bin` is `npm`, not `node`. The gate skips. npm then runs its script —
`node --test` — without `--test-timeout`. One indirection deeper, and the bound
stops applying.

`detectTestCommand` returns `npm test` / `pnpm test` / `yarn test` whenever
`package.json` declares a `scripts.test`. So the pm-delegated path is the
*common* auto-detected path for generated Node projects. The gap is the default,
not the exception.

## Three options, one correct

Three mechanisms were weighed:

**(a) npm test -- --test-timeout=N.** npm 11.x does forward args past `--`. But
`--test-timeout` is an invalid flag for jest, mocha, or vitest — so `npm test --
--test-timeout=60000` silently breaks working verification for any project whose
`scripts.test` isn't `node --test`. Making it safe requires reading `scripts.test`
first, at which point you've done the same IO as option (b) but with worse
cross-pm portability. pnpm and yarn handle `--` forwarding differently across
versions.

**(c) Environment variable.** Node 24's test runner exposes the per-test timeout
only as `--test-timeout=`. There is no `NODE_TEST_TIMEOUT`. Dead end.

**(b) Scoped command rewrite.** When (and only when) `scripts.test` trimmed and
split is exactly `node --test` with at most pre-existing `--test-timeout=<digits>`
flags and nothing else, rewrite the spawn target to `{ bin: 'node', args:
['--test'] }`. The existing injection then adds `--test-timeout`. A non-node-test
script is never touched. Pre-existing `--test-timeout=` in the script is stripped
before injection so exactly one appears. The raw `command` string (`npm test`) is
preserved in the summary so `hasRequiredTestCoverage` and `last-test.md` still key
on it.

This is the same scoped-rewrite precedent already in `resolveVerificationCommand`,
which swaps `npm` for `node --test` when `package.json` is absent. The new
`nodeTestScript(cwd)` helper is the IO-carrying equivalent: reads `package.json`,
applies the qualifier, returns `{ bin: 'node', args: ['--test'] }` or `null`.

## The safety guarantee

The qualifier is strict. `parts[0] === 'node' && parts[1] === '--test'`, and every
part at index ≥ 2 must match `/^--test-timeout=\d+$/u`. Anything else returns
null:

- `jest` → null (pm keeps running as-is)
- `node --test test/*.mjs` → null (extra path, not rewritten)
- `node --test && echo done` → null (&&, not rewritten)
- `node --test --test-timeout=999` → qualifies, 999 stripped, new value injected

The spawn uses `shell: false` throughout. No user or model string is interpolated
into args; the script content is only ever read to decide whether to rewrite, never
to build the spawn target.

## Where the change lives

Only `runVerification` (the `effective` computation) and the new module-scope
`nodeTestScript` helper. `parseVerificationCommand` is untouched — still pure,
sync, and IO-free. `detectTestCommand` is untouched — still returns `npm test` for
projects with a test script. `resolveVerificationCommand` is untouched. Every
caller (orchestration, run-pipeline, healing, tool-calls, eval) funnels through
the `effective` gate in `runVerification`, so the bound is applied uniformly.

## Tests

Seven new cases in `test/verification-runner.test.mjs`:

1. `npm test` + `scripts.test: 'node --test'` → rewrites bin to `node`, injects `--test-timeout`
2. `pnpm test` and `yarn test` with the same script → same
3. `testTimeoutMs: 5000` honored on the pm rewrite path
4. `scripts.test: 'jest'` → stays `{ bin: 'npm', args: ['test'] }`, no `--test-timeout` (the safety guarantee)
5. `scripts.test: 'node --test test/*.mjs'` (extra path) → not rewritten
6. `scripts.test: 'node --test --test-timeout=999'` + `testTimeoutMs: 7000` → exactly one `--test-timeout=7000`
7. `parseVerificationCommand('npm test && rm -rf .')` still throws `VerificationError`

Three existing tests updated to reflect the new spawned command:

- `marks node test runs with zero tests as failed`: stdout now contains
  `tests 0` rather than `> node --test` (npm output bypassed).
- `runs verification from a jailed test cwd` (app.test.mjs): stdout check
  updated to `/subproject test/u`, last-test.md check updated to `/npm test/u`
  (command string preserved).
- `runs dependency installation before verification` (orchestration.test.mjs):
  the injected commandRunner now receives `node --test --test-timeout=10000`
  instead of `npm test`; assertion updated accordingly.

## The door still open

This phase closes the per-test timeout gap for generated projects. It does not
address the other failure mode from the same run: the heal turn produced zero
content because the model's reasoning tokens consumed the entire 32K context
window. That is a different problem — a model budget constraint, not a per-test
timeout — and it already has a detailed NEXT.md candidate describing the
`max_thinking_tokens` / `max_completion_tokens` direction.

The 300-second hang was cheap to fix and independent. The reasoning runaway is
expensive to fix and still open.

## Test count: 1835 → 1842
