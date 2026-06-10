# Phase 85: Async HTTP Run Control And Observability

Phase 85 promotes `kodr serve` from the phase 50 synchronous sketch into a
small local control plane. The old `POST /turn` blocked until the model
finished and discarded all progress — workable for tests, useless for a local
model that thinks for three minutes. The new surface is task-shaped: submit a
run, get a handle, watch events, fetch artifacts.

## What Changed

- New `src/run-registry.mjs`: an in-memory registry holding run records,
  lifecycle transitions (`queued → running → completed|failed|cancelled`), a
  bounded per-run event buffer, and subscriber fan-out. It is deliberately not
  durable; artifacts under `.kodr/runs` stay the source of truth.
- `POST /runs` validates a strict field allowlist (`prompt`, `sessionId`,
  `continue`, `model`, `tools`, `yes`, `test`, `install`, `subagentStages`),
  maps each onto the same typed options the CLI uses, and returns `202` with
  `runId`, `eventsUrl`, and `statusUrl` before the model finishes.
- `GET /runs/:id/events` streams SSE built from the same `options.onProgress`
  events the CLI and TUI consume. The replay buffer plus `Last-Event-ID`
  support means a late or reconnecting client still sees recent history.
  Stderr info lines from the run adapter become `log` events, so
  `GET /runs/:id/logs` is the polling-friendly view of the same record.
- Artifact routes serve only allowlisted names from the recorded run
  directory. Traversal segments are rejected before path resolution, and the
  resolved path is checked against the run directory again afterwards.
- One active run at a time by default; later submissions queue with a recorded
  `queueReason` and start when the slot frees (`--max-active-runs` raises the
  cap to at most 8).
- `POST /runs/:id/cancel` is honest: queued runs cancel outright, active runs
  only record `cancelRequested` and the response says `bestEffort: true`.
  Threading an `AbortSignal` through model calls, tools, installers, and
  sandboxes is named follow-up work, per the phase spec's "keep the first
  implementation honest" rule.
- `POST /turn`, `GET /sessions`, and `GET /sessions/:id` are unchanged, and
  `POST /sessions/:id/turns` continues a session asynchronously.

## Design Notes

The HTTP layer stayed a thin adapter. The only new execution-path code is the
registry bookkeeping around `handleChannelRequest({ kind: 'run-turn' })`; the
run itself is byte-for-byte the CLI path, including dry-run-by-default for
writes. That was the phase's core constraint and it held without exceptions.

Run ids are server-generated (`run-<epoch>-<seq>`) rather than reusing the
artifact directory name, because the artifact directory does not exist until
the channel run starts producing it. The registry records the artifact
directory on completion and exposes it as a workspace-relative path.

Queue dispatch relies on `executeRun` marking the run as running synchronously
before its first `await`, so the dispatch loop sees the consumed slot in the
same tick and cannot double-start runs. Subtle, but it keeps the loop free of
locks.

## Failures Hit During The Phase

The first implementation passed `install: true` straight onto the channel
options and nothing happened: the real option is `installDependencies`. The
field-mapping test (`maps run fields onto typed channel options`) was written
to catch exactly this class of silent drift between HTTP body fields and
internal option names — worth keeping in mind for every future route field.

## Verification

- `test/run-registry.test.mjs` covers lifecycle, queue reasons, event-buffer
  bounding, replay-from-id, subscriber fan-out, and pruning.
- `test/server.test.mjs` drives the spec's scripted multi-turn scenario with a
  fake channel: submit, observe running state, stream SSE to `done`, continue
  the session via `POST /sessions/:id/turns`, list and fetch artifacts, and
  exercise the artifact jail (unlisted names 403, traversal 403, missing 404).
- Existing `/turn` compatibility tests pass unchanged.
