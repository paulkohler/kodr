# Phase 25: CSV Expense Example

The fourth example app is a CSV expense analyzer. It exercises a different class of work than the previous examples: parsing quoted delimited text, validating records, aggregating numeric data, and producing CLI reports.

Kodr attempted the generation first, but the local LM Studio request failed with `fetch failed` after several minutes. The failure artifacts were preserved at `.koder/runs/2026-05-26T10-45-57.712Z`, so no additional harness fix was needed for this failure mode.

The example was completed manually under `examples/csv-expenses`. It uses Node built-ins, parses quoted CSV fields with escaped quotes, validates dates and numeric amounts, groups totals by month and category, and prints a readable text report from a CLI.

The tests cover parsing, validation failures, grouping, report formatting, and end-to-end CLI output.
