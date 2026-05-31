# Postgres Documents API Trial

The Postgres documents API was the first deliberately service-shaped example:
Express.js, `pg`, Docker Compose, migrations, and integration tests. It was a
better stress test than the earlier file-oriented examples because it forced
Kodr to handle dependencies, external services, test lifecycle, and multi-file
API structure.

The initial generation succeeded in the narrow sense: Kodr produced an Express
app, schema migration, routes, tests, Docker Compose file, package metadata, and
README. The first failure was not model transport or JSON extraction. It was
ordinary generated code quality: the tests defined a helper named `fetch` and
then called `fetch` inside it, recursively shadowing `globalThis.fetch`. That
turned into stack overflow and out-of-memory failures.

The second failure was repair behavior. Follow-up Kodr repair prompts repeatedly
returned an OK envelope with zero file changes and a scratchpad saying the model
needed to inspect files. Tool-mode repair then exhausted its turn budget without
converging. That is exactly the class of issue the later self-healing phases
need to address: a scratchpad-only response is not success when the requested
task is a repair.

This trial also confirmed two harness concerns:

- dependency installation needs to be a controlled workflow, not a manual driver
  step
- root `npm test` should not accidentally execute nested service-integration
  tests that require Docker or Postgres

The app is left unfixed as a Kodr sample. Fixing it by hand would turn the
example into a false positive. The useful artifact is the failure trail.
