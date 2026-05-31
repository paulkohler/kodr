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

## Nemotron Take 2 Transport Failure

A fresh take2 run failed before producing a usable assistant response:

```text
Model run failed: POST http://localhost:1234/v1/chat/completions failed: fetch failed
```

The Kodr artifacts did not explain enough. `context.md` and `raw-request.json`
were small, so this was not a packed-context problem. The LM Studio
`server.log` had the missing evidence: the model generated a very large hidden
reasoning trace with empty assistant content, then the client disconnected after
several minutes. The server reported no truncation, so this also did not look
like a max-output-token failure.

The harness fix is to preserve structured transport details in failed run
artifacts: request phase, elapsed time, timeout, request body size, HTTP status
and response samples when present, and nested cause metadata from `fetch`.

The same run exposed a separate context hygiene issue. Because the output
directory was named `.kodr-nemotron-test2`, Kodr listed prior run artifacts as
workspace files. That is confusing even when byte budgets keep the prompt small,
so `.kodr` and `.kodr-*` directories are now excluded from context discovery.

A retry with the richer diagnostics exposed the real cutoff:
`UND_ERR_HEADERS_TIMEOUT` after about 300 seconds, despite `--timeout-ms
600000`. This was not Kodr's abort timeout. It was Node's fetch implementation
using undici's default response-header timeout. LM Studio can spend several
minutes generating before it sends any HTTP response headers, especially with a
reasoning-heavy model, so fetch can fail while the model is visibly still
generating.

The transport now uses built-in `node:http` and `node:https` directly. That
keeps the project zero-dependency and makes Kodr's configured timeout the
timeout that actually governs slow local model requests.
