# Phase 04: Prompt Runs And Artifacts

## Goal

Make a single prompt run repeatable and inspectable.

## Build Steps

- [ ] Extract shared OpenAI-compatible client code from `koder probe`.
- [ ] Extract shared run artifact writing.
- [ ] Add `koder run -p "task"`.
- [ ] Add `--prompt-file`.
- [ ] Add `--out`.
- [ ] Save `prompt.md`, `response.md`, `summary.json`, and raw response JSON.
- [ ] Implement continuation stitching for `finish_reason: "length"`.

## Done Criteria

- [ ] Fake model tests cover normal and continuation responses.
- [ ] Run artifacts are deterministic enough to compare across models.
- [ ] Probe behavior still uses the shared client and passes existing tests.
- [ ] Blog post documents the artifact layout.

## Notes

Do not pile prompt-run behavior directly into `src/app.mjs`. Keep the CLI dispatch thin enough that later phases can reuse the model client, continuation stitching, and artifact writer.
