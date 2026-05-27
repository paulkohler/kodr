# Local Markdown Search Example Provenance

This example is intended to be a Kodr sample.

## Runs

- Scaffold slice failed verification.
  - Prompt: `prompts/031-markdown-search-scaffold.md`
  - Artifact: `.koder/runs/2026-05-26T20-59-03.521Z`
  - Result: applied scaffold files.
  - Verification: failed because `rm` was not imported in the test cleanup.
- Scaffold repair attempt exposed non-atomic patch application.
  - Prompt: `prompts/031-markdown-search-scaffold-repair.md`
  - Artifact: `.koder/runs/2026-05-26T21-01-14.120Z`
  - Result: earlier patches applied before a later stale provenance patch failed.
  - Follow-up: Kodr now validates patch batches before applying them.
- Provenance-only repair timed out.
  - Prompt: `prompts/031-markdown-search-provenance-repair.md`
  - Artifact: `.koder/runs/2026-05-26T21-04-20.343Z`
  - Result: model run timed out before returning output.
- Core implementation slice failed verification.
  - Prompt: `prompts/031-markdown-search-core.md`
  - Artifact: `.koder/runs/2026-05-26T21-14-49.663Z`
  - Result: applied search and CLI implementation, but verification failed because zero-score documents were returned and the CLI import was incomplete.
- Core implementation repair passed.
  - Prompt: `prompts/031-markdown-search-core-repair.md`
  - Artifact: `.koder/runs/2026-05-26T21-17-43.793Z`
  - Result: applied a narrow repair so zero-score documents are skipped and the CLI imports `searchIndex`.
- Test expansion slice failed verification.
  - Prompt: `prompts/031-markdown-search-tests.md`
  - Artifact: `.koder/runs/2026-05-26T21-20-37.198Z`
  - Result: applied broader tests, but verification failed because generated tests missed an import and used non-Markdown file extensions.
- Test repair failed on stale patch anchors.
  - Prompt: `prompts/031-markdown-search-tests-repair.md`
  - Artifact: `.koder/runs/2026-05-26T21-22-22.002Z`
  - Result: no writes applied because patch search strings were over-escaped and did not match current files.
- Exact test repair exposed same-file patch composition.
  - Prompt: `prompts/031-markdown-search-tests-exact-repair.md`
  - Artifact: `.koder/runs/2026-05-26T21-25-36.761Z`
  - Result: verification failed after only the last same-file patch survived.
  - Follow-up: Kodr now composes multiple patches for the same target before writing.
- Final repair proposal was rejected safely.
  - Prompt: `prompts/031-markdown-search-final-repair.md`
  - Artifact: `.koder/runs/2026-05-27T01-10-11.827Z`
  - Result: no writes applied because the model used stale indentation and placeholder patch anchors.
  - Follow-up: the same narrow intent was stabilized manually after the harness preserved the failed proposal artifact.

## Notes

The scaffold, core implementation, and several repairs are model-generated Kodr outputs. The final stabilization kept the model proposal's narrow intent but used manual patches after the safe-writes layer rejected stale anchors. This remains useful provenance: the example passed after the harness avoided partial writes and preserved the failed proposal for inspection.
