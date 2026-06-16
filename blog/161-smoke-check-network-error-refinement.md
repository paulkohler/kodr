# Phase 161: Smoke-Check Network-Error Refinement

The smoke-check's failure classifier (`classifyLoadFailure`) previously had two
known-inconclusive exits — missing bare dependencies and unsettled top-level
await — and classified everything else as a definitive failure.

That missed a whole family: entries that eagerly connect to an external resource
at startup (Postgres pool, Redis, external API). On the probe host there's no
database, so the entry throws `ECONNREFUSED`, `ENOTFOUND`, or `ETIMEDOUT`
before any business logic runs. The code is correct; the environment is just
missing a service.

Six network error codes now map to `status: 'skipped'` (inconclusive):

| Code | Cause |
|---|---|
| ECONNREFUSED | No listener on the target port |
| ECONNRESET | Connection closed before handshake |
| ENOTFOUND | DNS lookup failed |
| ETIMEDOUT | Connection attempt timed out |
| EHOSTUNREACH | No route to host |
| EADDRINUSE | Port already in use — probe may collide with a running process |

`EADDRINUSE` is included because the probe subprocess could try to bind to
a port already held by a background process on the developer's machine.

NEXT.md originally flagged this as a potential false-positive from Phase 155's
Express example. That example used a lazy pool and never triggered the issue in
practice, but adding the refinement proactively is cheap and the pattern is
identical to the existing dep-missing downgrade.
