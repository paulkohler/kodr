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

## Nemotron Repair Attempt

After Docker was started, I reran the repair with
`nvidia/nemotron-3-nano-omni`, `--tools`, and `--max-turns 50`. This model did
better than qwen on one dimension: it produced an actual patch instead of a
scratchpad-only no-op.

The patch was still incomplete. It fixed the recursive helper in
`tests/health.test.js` and removed the duplicate README sections, but it created
a new root-level `utils.js` instead of patching `tests/utils.js`. The users and
documents tests still import the old recursive helper, so they continued to
crash with out-of-memory failures. The health assertions passed, but the test
file still left event-loop work pending, likely because server or Postgres pool
lifecycle was not closed cleanly.

This was a better failure. It shows that model choice matters, but also that the
harness needs path-aware repair pressure: when the prompt names
`tests/utils.js`, a created sibling `utils.js` is probably wrong and should be
flagged before we call the repair successful.
