# Phase 03: Fake Model Server And Recorder

## Goal

Test local-model client behavior without requiring LM Studio during test runs.

## Build Steps

- [ ] Add native HTTP fake server test helper.
- [ ] Implement `/v1/models`.
- [ ] Implement `/v1/chat/completions`.
- [ ] Add configurable response queue.
- [ ] Add request/response recorder.
- [ ] Redact `authorization` headers in recordings.

## Recorder Shape

```js
{
  startedAt,
  durationMs,
  method,
  url,
  requestHeaders,
  requestBody,
  responseStatus,
  responseBody
}
```

## Done Criteria

- [ ] Tests can assert recorded request bodies.
- [ ] Tests can assert recorded response bodies.
- [ ] Blog post explains why recorder evidence matters.
