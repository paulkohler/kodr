# Phase 02: LM Studio Probe

## Goal

Prove local OpenAI-compatible connectivity against LM Studio.

## Build Steps

- [x] Add `koder probe`.
- [x] Call `GET /models`.
- [x] Call `POST /chat/completions` with a tiny prompt.
- [x] Support `--base-url`, `--model`, `--api-key`, `--timeout-ms`, and `--json`.
- [x] Write run artifacts under `.koder/runs/<timestamp>/`.

## Done Criteria

- [x] Fake-server tests pass.
- [x] Real local LM Studio smoke test is documented when available.
- [x] Blog post records the probe design.

## Local Smoke Test

Ran against LM Studio with `nvidia/nemotron-3-nano-omni` loaded:

```sh
./koder probe --model nvidia/nemotron-3-nano-omni --timeout-ms 600000 --json
```

Result: passed, with artifacts written under `.koder/runs/2026-05-25T22-39-03.504Z/`.
