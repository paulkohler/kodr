# Phase 239 — Hardening Audit Fixes

## Motivation

A repository-wide review after phase 238 found security-boundary gaps, one
incorrect piece of shipped Node guidance, a load-sensitive test, documentation
that contradicted the apply-by-default contract, a builtin-skill resolution
gap, and renewed concentration in the largest implementation and test files.

This is a hardening phase: preserve behavior where it is correct, repair the
identified boundaries and contracts, and improve the seams that make future
review possible. It does not add a new product surface.

## Scope

- Protect `kodr serve` mutations from cross-origin requests and DNS rebinding.
- Make `fetch_url` connect to the address that passed private-network checks.
- Bound non-streaming and SSE model response accumulation.
- Correct the Node ESM query-string guidance and test the real Node 24 behavior.
- Resolve explicit `--skill` requests through the builtin registry.
- Remove the healing test's dependence on a one-second subprocess deadline.
- Split oversized help/reporting/test surfaces along existing module seams.
- Correct apply-by-default documentation.
- Replace `docs/ARCHITECTURE.md` with a current architecture assessment.
- Record the review failures and hardening decisions.

## Security semantics to verify

- Node 24 ESM caches modules by URL; different queries load distinct instances.
- Node `http.request` supports a custom `lookup`, allowing the validated address
  to be pinned for the actual connection.
- Browser simple requests can use `text/plain`, so mutation routes must not rely
  on JSON parsing alone as a cross-origin boundary.

## Done criteria

- [x] HTTP routes enforce a local Host/Origin contract and JSON mutation bodies.
- [x] HTTP security tests cover hostile Origin/Host and non-JSON content types.
- [x] `fetch_url` pins the validated DNS result and covers rebinding-shaped and
      mapped/private IPv6 inputs.
- [x] Model response byte limits cover JSON, SSE text, SSE framing buffers, and
      streamed tool-call arguments.
- [x] Node skill guidance matches Node 24 runtime behavior and has a behavioral
      regression test.
- [x] Explicit builtin skill selection works outside the Kodr repository.
- [x] The parallel test suite is not dependent on a one-second `node --check`.
- [x] CLI usage and run reporting are extracted from oversized core modules;
      staged tests are moved to a focused test module where practical.
- [x] README, usage guide, and CLI help agree on apply/test defaults.
- [x] `docs/ARCHITECTURE.md` is a fresh current assessment, not phase-223 notes.
- [x] `process/decisions.jsonl` and `process/failures.jsonl` record the phase.
- [x] A matching blog post explains the failures and fixes.
- [x] `npm run format`, `npm test`, and `npm run check` pass.
- [x] Review confirms no unrelated behavior or public API drift.
- [x] Commits capture the hardening work in logical units.
