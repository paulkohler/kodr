# Phase 156: Executable Smoke-Check in Verification

## Motivation

The phase-155 capability stress test (`process/failures.jsonl` `155-stress`) built a
structurally excellent Express/JWT/pg API with qwen — correct cross-file wiring, real
parameterised SQL, a Postgres schema that initialised against a live `postgres:16`
container — but it **failed at startup**: `src/auth.mjs` did
`import { sign, verify } from "jsonwebtoken"`, and jsonwebtoken is CommonJS whose named
exports are not statically detectable, so Node throws at module-link time. The run
reported `ok=true`.

The gap is structural. `node --check` (the phase-121 syntax gate) only *parses* each
file; it never resolves imports or links the module graph, so a missing-export /
CJS-ESM-mismatch / import-time crash sails through. With `--no-test` (or no detectable
test command) the only remaining gate is the advisory model-reviewer, which reasons
about source but never *loads* it. On the static-site half of the same stress test the
reviewer caught both real bugs by static reasoning — it is specifically *load-time*
errors that slip through, because catching them requires executing the module graph.

This phase adds a deterministic **load probe**: when writes were applied and the project
has a detectable JS entry point, `import()` that entry in a child process and observe
whether the module graph links and evaluates without throwing.

## Decision: what the probe does and how strict it is

- **Mechanism.** Spawn `node --input-type=module --eval <loader>` with the entry's
  absolute path passed via `KODR_SMOKE_ENTRY` (no string interpolation of paths). The
  loader dynamically `import()`s the entry; on resolve it exits 0, on reject it prints
  the error stack and exits 1. A dynamic import resolves *after* top-level evaluation, so
  an entry that calls `app.listen()` resolves the moment `listen` returns synchronously —
  the loader then `process.exit(0)` immediately, killing the dangling socket. A bounded
  timeout (process-group kill) is the backstop for genuine top-level-await hangs.

- **Entry detection.** Read `package.json`; prefer `scripts.start` of the exact form
  `node <file>` (parse the file out), else `main`. Resolve to an existing,
  workspace-relative `.mjs`/`.cjs`/`.js` file (reject absolute paths and `..`). No
  `package.json`, no resolvable JS entry → no probe. `index.html` is out of scope: a load
  probe cannot `import()` HTML, and DOM/script execution is a different kind of check.

- **Trigger.** Mirror the syntax gate: only when writes were *applied* and at least one
  written file is JS, and only after the syntax gate passed (no point load-probing a file
  that does not parse). Independent of `testCommand` — this is exactly the `--no-test`
  gap. Naturally skipped in `--dry-run` (nothing applied).

- **Strictness — definitive failure blocks, inconclusive stays advisory.** A clean
  non-zero exit with a thrown error (`status: 'failed'`) flips `summary.ok` to false,
  parallel to the syntax gate's reasoning ("a file that does not parse is not a passing
  run"): an app that throws at import provably cannot start. But two inconclusive outcomes
  must *not* be treated as failures, or the probe becomes a false-negative machine:
  - **Dependencies not installed** — a bare-specifier `ERR_MODULE_NOT_FOUND` / "Cannot
    find package" means deps aren't on disk (the default pipeline does not `npm install`),
    not that the code is broken. Downgrade to `status: 'skipped'`. The missing-*export*
    SyntaxError is distinct and stays `failed` (this is the jsonwebtoken case).
  - **Timeout** — a hang (pathological top-level await) is `status: 'timeout'`, advisory.

- **Trust boundary.** This *executes* untrusted model-written top-level module code —
  a real escalation beyond `node --check`'s parse-only. Mitigations: (1) it runs only on
  the **host** and is **skipped when a sandbox executor is active** (`activeExecutor`
  non-null), so it never escapes an existing Docker/OpenShell sandbox to run model code on
  the host; on host it is the same trust level already crossed by the test runner and
  dependency-install, both of which execute workspace code; (2) bounded by a timeout +
  process-group kill; (3) opt out with `--no-smoke`. Routing the probe *through* the
  sandbox executor (so it can run under Docker) is recorded as follow-up, not this phase.

- **Not in scope.** Feeding a failed smoke-check into the heal loop (synthesising a
  verification-shaped result the way the syntax gate does) — recorded as follow-up. This
  phase surfaces the failure and flips `ok`; it does not yet drive an automatic repair.

## Done criteria

- [x] `src/smoke-check.mjs`: `detectEntryPoint(cwd)`, `runSmokeCheck(cwd, entry, opts)`,
      `runSmokeCheckIfNeeded(cwd, writeResult, opts)` with the classification above.
- [x] Wired into `src/run-pipeline.mjs` after the syntax gate: records
      `summary.smokeCheck`; a `failed` status flips `summary.ok` (unless tests pass);
      skipped when a sandbox executor is active or `options.smoke === false`.
- [x] `--no-smoke` flag (`options.smoke`, default true) in `src/cli/args.mjs` + help text.
- [x] Forensics renders a `smokeCheck` step in the Verification phase
      (`src/forensics.mjs`).
- [x] `test/smoke-check.test.mjs`: entry detection (start/main/none/non-JS/traversal),
      good module → ok, throw-at-import → failed, missing-export → failed, missing dep →
      skipped, hanging entry → timeout, unsettled TLA → inconclusive. Plus a `--no-smoke`
      args test and forensics render tests.
- [x] `npm run format`, full suite green (1503), `npm run check` green.
- [x] `process/decisions.jsonl` + `process/failures.jsonl` updated; blog post written;
      roadmap item checked; version bumped to 0.0.156; committed.

## Implementation note: the unsettled-TLA discovery

The probe's timeout backstop turned out to be subtler than expected. The first draft of
the timeout test used `await new Promise(() => {})` as a "hangs forever" entry — but Node
detects an unsettled top-level await when the event loop would otherwise empty and exits
with code 13 almost instantly, so it never reached the wall-clock timeout. That is
actually the *right* signal to handle: nothing was thrown, so it must not be a hard
failure. `classifyLoadFailure` now maps "unsettled top-level await" to an inconclusive
(`skipped`) outcome, and the timeout path is reserved for a genuine hang (a keep-alive
timer plus a pending TLA), which the process-group kill terminates.
