# Phase 04: Prompt Runs And Artifacts

## Goal

Make a single prompt run repeatable and inspectable.

## Build Steps

- [x] Extract shared OpenAI-compatible client code from `kodr probe`.
- [x] Extract shared run artifact writing.
- [x] Add `kodr run -p "task"`.
- [x] Add `--prompt-file`.
- [x] Add `--out`.
- [x] Save `prompt.md`, `response.md`, `summary.json`, and raw response JSON.
- [x] Implement continuation stitching for `finish_reason: "length"`.

## Done Criteria

- [x] Fake model tests cover normal and continuation responses.
- [x] Run artifacts are deterministic enough to compare across models.
- [x] Probe behavior still uses the shared client and passes existing tests.
- [x] Blog post documents the artifact layout.

## Notes

Do not pile prompt-run behavior directly into `src/app.mjs`. Keep the CLI dispatch thin enough that later phases can reuse the model client, continuation stitching, and artifact writer.
