# Phase 03: Fake Model Server And Recorder

## Goal

Test local-model client behavior without requiring LM Studio during test runs.

## Build Steps

- [x] Add native HTTP fake server test helper.
- [x] Implement `/v1/models`.
- [x] Implement `/v1/chat/completions`.
- [x] Add configurable response queue.
- [x] Add request/response recorder.
- [x] Redact `authorization` headers in recordings.

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

- [x] Tests can assert recorded request bodies.
- [x] Tests can assert recorded response bodies.
- [x] Blog post explains why recorder evidence matters.
