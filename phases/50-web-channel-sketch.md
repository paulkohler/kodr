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

- [ ] Add local-only `kodr serve`.
- [ ] Implement `GET /sessions`.
- [ ] Implement `GET /sessions/:id`.
- [ ] Implement `POST /turn`.
- [ ] Ensure all routes use the central channel handler.
- [ ] Tests cover route behavior and bad requests.
- [ ] Record decisions and any failures.
- [ ] Blog post.
