# Phase 50: Web Channel Sketch

The terminal UI proved that Kodr needs channels rather than one-off command
paths. Phase 50 adds the smallest useful proof for a future web UI: `kodr
serve`, a local-only JSON HTTP server with no frontend bundle and no
dependencies.

The important constraint is that HTTP is not a second harness. Each route adapts
into the same central channel handler used by the CLI and TUI:

- `GET /sessions` maps to `session-list`.
- `GET /sessions/:id` maps to `session-show`.
- `POST /turn` maps to `run-turn`.

That means route behavior can evolve without bypassing session browsing, run
artifacts, dry-run defaults, model settings, or later channel policy.

One security detail became clearer while writing the tests: web turns should not
inherit ambient apply/session state from the process. `POST /turn` resets to
dry-run and no session by default, then accepts explicit `yes`, `sessionId`, or
`continue` fields from the request body. This keeps the web channel aligned with
Kodr's "model output is untrusted" rule and avoids surprising writes just
because the server process was started with broader options.

The route tests use a fake channel, not LM Studio. That keeps the contract fast
and deterministic: tests assert that each endpoint calls the right channel
request shape, rejects malformed input, maps missing sessions to 404, and refuses
non-local bind hosts.

The live LM Studio check was still valuable as an integration smoke test: start
`kodr serve`, post a simple turn through `/turn`, and confirm the request flows
all the way through the model-backed run path.
