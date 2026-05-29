# Phase 50: Web Channel Sketch

## Goal

Prove the channel abstraction can support a future web UI without building a
large frontend.

Add a tiny zero-dependency local HTTP channel backed by the same request
handler.

## Design

Add:

- `kodr serve`
- `GET /sessions`
- `GET /sessions/:id`
- `POST /turn`

The server should be local-only by default and should not add dependencies or a
frontend bundle. This is a channel sketch, not a full product UI.

## Done Criteria

- [x] Add local-only `kodr serve`.
- [x] Implement `GET /sessions`.
- [x] Implement `GET /sessions/:id`.
- [x] Implement `POST /turn`.
- [x] Ensure all routes use the central channel handler.
- [x] Tests cover route behavior and bad requests.
- [x] Record decisions and any failures.
- [x] Blog post.
