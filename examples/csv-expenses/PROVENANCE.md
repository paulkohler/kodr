# CSV Expense Example Provenance

This example is intended to be a Kodr sample.

## Runs

- One-shot generation failed before returning model output.
  - Artifact: `.koder/runs/2026-05-26T10-45-57.712Z`
  - Result: `POST /chat/completions failed: fetch failed`
  - Follow-up: split the work into smaller Kodr slices instead of accepting a manual-only fixture.
- Parser slice without streaming failed before returning model output.
  - Prompt: `prompts/026-csv-expense-parser-slice.md`
  - Artifact: `.koder/runs/2026-05-26T11-19-06.646Z`
  - Result: `POST /chat/completions failed: fetch failed`
  - Follow-up: add streaming chat completion support and retry the slice.
- Parser slice with streaming applied a real parser improvement.
  - Prompt: `prompts/026-csv-expense-parser-slice.md`
  - Artifact: `.koder/runs/2026-05-26T11-25-32.216Z`
  - Result: model transport succeeded and updated `examples/csv-expenses/src/expenses.mjs`.
  - Verification: failed because the tests still expected the old missing-column diagnostic.
- Test repair slice updated the diagnostic assertion.
  - Prompt: `prompts/026-csv-expense-test-repair-slice.md`
  - Artifact: `.koder/runs/2026-05-26T11-35-28.089Z`
  - Result: applied the test repair.
  - Verification: failed because the CSV escaped-quote fixture was changed from doubled CSV quotes to backslash-style quotes.
- Quote repair slice attempted to restore doubled CSV quotes.
  - Prompt: `prompts/026-csv-expense-quote-test-repair-slice.md`
  - Artifact: `.koder/runs/2026-05-26T11-37-25.240Z`
  - Result: applied a test edit.
  - Verification: failed with a JavaScript syntax error in the repaired assertion.
- Syntax repair slice fixed the malformed assertion but regressed the quote fixture again.
  - Prompt: `prompts/026-csv-expense-syntax-repair-slice.md`
  - Artifact: `.koder/runs/2026-05-26T11-40-17.955Z`
  - Result: applied a syntactically valid test edit.
  - Verification: failed because the fixture again used backslash-style quotes.

## Historical Stabilization

Before Phase 28, this example still included a small human stabilization that restored the doubled-quote CSV fixture after repeated full-file repair slices regressed it. That failure directly led to patch-oriented repairs. The canonical example now has a successful Kodr patch chain recorded below.

## Regeneration Attempt

- Core regeneration slice rewrote the implementation but failed verification.
  - Prompt: `prompts/027-csv-regenerate-core.md`
  - Artifact: `.koder/runs/2026-05-26T19-38-09.042Z`
  - Result: applied a full-file rewrite.
  - Verification: failed because required exports and behavior were missing.
- Core full-file repair was stopped after it continued the same broad-rewrite path.
  - Prompt: `prompts/027-csv-core-repair.md`
  - Result: interrupted before accepting another full-file repair.
  - Follow-up: move patch-oriented repairs ahead of CSV regeneration.
- Patch repair attempt produced a stale patch diagnostic.
  - Prompt: `prompts/027-csv-core-patch-repair.md`
  - Artifact: `.koder/runs/2026-05-26T19-52-24.963Z`
  - Result: failed safely before applying because the patch search text did not match current file content.
- Patch repair retry applied after newline normalization but failed verification.
  - Prompt: `prompts/027-csv-core-patch-repair.md`
  - Artifact: `.koder/runs/2026-05-26T19-59-51.100Z`
  - Result: applied a patch and ran tests.
  - Verification: failed because the patch duplicated helper functions and did not complete the repair list.

The canonical CSV regeneration is deferred to Phase 28 so it can use patch proposals deliberately, and likely a scratchpad/task discipline if repair complexity continues to grow.

## Canonical Regeneration

Phase 28 kept the passing baseline, then used successful Kodr patch runs to make the canonical example traceable without accepting another broad full-file rewrite.

- Combined parser/test edge-case patch returned an invalid proposal.
  - Prompt: `prompts/028-csv-add-parser-edge-case.md`
  - Artifact: `.koder/runs/2026-05-26T20-13-25.567Z`
  - Result: failed safely with `Proposal patches must have string path, search, and replace`.
  - Follow-up: split source and test changes into separate patch prompts.
- Source-only parser input validation patch initially failed on whitespace drift.
  - Prompt: `prompts/028-csv-parse-input-source-patch.md`
  - Artifact: `.koder/runs/2026-05-26T20-17-09.743Z`
  - Result: failed safely because the patch search did not match current text.
  - Follow-up: add conservative whitespace-tolerant matching for unique patch windows.
- Exact source patch succeeded.
  - Prompt: `prompts/028-csv-exact-source-patch.md`
  - Artifact: `.koder/runs/2026-05-26T20-20-16.528Z`
  - Result: added `parseCsv` non-string input validation and passed example tests.
- Exact test patch succeeded.
  - Prompt: `prompts/028-csv-exact-test-patch.md`
  - Artifact: `.koder/runs/2026-05-26T20-23-00.653Z`
  - Result: added native `node:test` coverage for non-string input validation and passed example tests.
- Wrapper/docs/sample patch succeeded.
  - Prompt: `prompts/028-csv-exact-wrapper-patch.md`
  - Artifact: `.koder/runs/2026-05-26T20-24-51.777Z`
  - Result: refreshed the README language and sample CSV through Kodr patches, then passed example tests.
