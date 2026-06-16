# Phase 161: Smoke-Check Network-Error Refinement

## Motivation

The smoke-check was designed to catch import-time crashes (the CJS/ESM
named-export class from phase 155). But a generated entry that eagerly connects
to a database or service at startup would throw `ECONNREFUSED` under the probe —
no database is running at probe time — and the current `classifyLoadFailure`
would classify that as `status: 'failed'`, flipping `summary.ok = false`, even
though the code itself is fine.

The phase-155 Express example used a lazy pool (`pool.connect()` inside a route
handler, not at the top level) so this didn't bite in practice. But it's a clear
false-positive scenario, and NEXT.md already flagged it as "handle when a real
run reproduces it." Adding it proactively before it causes a false failure is
cheap and well-understood.

## What this phase does

`src/smoke-check.mjs` — `classifyLoadFailure`:
- Adds detection for `ECONNREFUSED`, `ECONNRESET`, `ENOTFOUND`, `ETIMEDOUT`,
  `EHOSTUNREACH`, and `EADDRINUSE` in stderr.
- Maps any of these to `status: 'skipped'` with message `"network error at load
  time (<error>) — smoke-check inconclusive"`.
- Rationale: these errors mean the entry tried to reach an external resource
  (DB, Redis, a port) not available at probe time. The code may be correct; the
  probe environment is not. Inconclusive is the right classification.
- `EADDRINUSE` is included: the probe launches the entry in a subprocess — if
  the entry calls `listen()` on a port already in use on the host, Node throws
  EADDRINUSE at startup. The code is fine; the probe just collided with an
  existing process.

`test/smoke-check.test.mjs`:
- 4 new `classifyLoadFailure` tests: ECONNREFUSED, ENOTFOUND, ETIMEDOUT,
  EADDRINUSE — each verifies `status: 'skipped'` and the refinement message.

## Done criteria

- [x] All 6 network error codes → `status: 'skipped'`.
- [x] 4 new tests; suite 1548 green; format + check clean.
- [x] Decisions logged; roadmap checked; version bump; committed.
