# Phase 03: Fake Model Server And Recorder

Phase 03 turns the one-off fake server from the probe tests into reusable test infrastructure.

## Decision

Add a native `node:http` fake model server under `test/` instead of requiring LM Studio during automated tests.

## Design

The helper implements two OpenAI-compatible endpoints:

- `GET /v1/models`
- `POST /v1/chat/completions`

It also accepts a response queue. Tests can override one response, consume it, and then fall back to the default fake model behavior.

Every request records method, URL, redacted headers, parsed request body, response status, response body, start time, and duration.

## Why Recorder Evidence Matters

Model calls are easy to misunderstand because the real failure can be in the request, the endpoint shape, the model response, or the caller's parsing assumptions. A recorder gives tests concrete evidence about both sides of the exchange.

The recorder also redacts `authorization` so tests can assert header behavior without preserving secrets.

## Verification

```sh
npm run format
npm test
npm run check
```
