# Phase 37: Eval And Scoring

## Goal

Add a scoring layer so run quality can be measured, not just observed. The
gpt-5.4-nano todo-cli run surfaced design differences (UUID ids, wrapped JSON)
and a test bug — but detecting those required manual inspection. An eval harness
makes that systematic.

## Design

- Define an `EvalSuite` as a list of cases: prompt, expected outputs or
  assertions, optional test command.
- Each case produces a score: pass/fail per assertion plus an optional numeric
  quality score (0–1).
- Built-in assertion types to start:
  - `files_exist` — named output files were created.
  - `tests_pass` — the generated test suite passes.
  - `content_matches` — output contains a pattern.
- Add `kodr eval --suite path/to/suite.json` that runs all cases and writes an
  `eval-results.json` summary.
- Wire eval results into the comparison report (phase 36) when both are present.

## Done Criteria

- [x] `EvalSuite` schema and loader.
- [x] `kodr eval` command with results artifact.
- [x] Three built-in assertion types with tests.
- [x] At least one eval suite for the todo-cli example that catches the
      test-bug pattern from phase 34.
- [x] Record decisions and any failures.
- [x] Blog post.
