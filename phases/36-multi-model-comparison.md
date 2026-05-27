# Phase 36: Multi-Model Comparison

## Goal

Run the same prompt against multiple models (local or OpenRouter) and produce a
structured comparison report. The gpt-5.4-nano todo-cli run in phase 34 was
entirely manual — this phase makes model comparison a first-class harness
operation.

## Design

- Add a `kodr compare` command that accepts a prompt and a list of model IDs.
- Run each model in sequence (or parallel with a concurrency limit), collecting
  run artifacts per model under a shared comparison run directory.
- Produce a `comparison.json` summary: per-model result, finish reason, token
  usage, cost, response length, and whether tests passed.
- Allow `--openrouter` and local models to be mixed in the same comparison.
- Keep individual run artifacts intact so each model's response can be replayed
  or inspected.

## Done Criteria

- [x] `kodr compare` command with `--models m1,m2` and prompt flags.
- [x] Comparison run directory with per-model sub-artifacts and `comparison.json`.
- [x] Tests cover: multi-model dispatch, artifact layout, summary structure.
- [x] Works with at least one local model and one OpenRouter model in a live test.
- [x] Record decisions and any failures.
- [x] Blog post.
