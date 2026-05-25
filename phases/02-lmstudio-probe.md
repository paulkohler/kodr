# Phase 02: LM Studio Probe

## Goal

Prove local OpenAI-compatible connectivity against LM Studio.

## Build Steps

- [ ] Add `koder probe`.
- [ ] Call `GET /models`.
- [ ] Call `POST /chat/completions` with a tiny prompt.
- [ ] Support `--base-url`, `--model`, `--api-key`, `--timeout-ms`, and `--json`.
- [ ] Write run artifacts under `.koder/runs/<timestamp>/`.

## Done Criteria

- [ ] Fake-server tests pass.
- [ ] Real local LM Studio smoke test is documented when available.
- [ ] Blog post records the probe design.
