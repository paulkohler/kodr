# Phase 02: LM Studio Probe

The probe is the first real connection between Kodr and a local OpenAI-compatible model server.

## Decision

Add `koder probe` as a small connectivity check before building full prompt runs.

## Design

The command calls `GET /models`, chooses the requested model or the first returned model, then sends a tiny `POST /chat/completions` request. It supports `--base-url`, `--model`, `--api-key`, `--timeout-ms`, and `--json`.

Every run writes artifacts under `.koder/runs/<timestamp>/` so model behavior can be inspected without trusting terminal output alone.

## Why

LM Studio is local-first, but it is still an external service from Kodr's point of view. A probe gives the project a fast way to separate CLI bugs, endpoint problems, model loading problems, and response-shape surprises.

## Smoke Test

With LM Studio running and `nvidia/nemotron-3-nano-omni` loaded:

```sh
./koder probe --model nvidia/nemotron-3-nano-omni --timeout-ms 600000 --json
```

The command passed and wrote artifacts to `.koder/runs/2026-05-25T22-39-03.504Z/`.

## Verification

```sh
npm test
npm run check
```
