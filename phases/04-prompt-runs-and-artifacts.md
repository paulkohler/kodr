# Phase 04: Prompt Runs And Artifacts

## Goal

Make a single prompt run repeatable and inspectable.

## Build Steps

- [ ] Add `koder run -p "task"`.
- [ ] Add `--prompt-file`.
- [ ] Add `--out`.
- [ ] Save `prompt.md`, `response.md`, `summary.json`, and raw response JSON.
- [ ] Implement continuation stitching for `finish_reason: "length"`.

## Done Criteria

- [ ] Fake model tests cover normal and continuation responses.
- [ ] Run artifacts are deterministic enough to compare across models.
- [ ] Blog post documents the artifact layout.
