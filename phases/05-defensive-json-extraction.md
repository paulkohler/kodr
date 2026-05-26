# Phase 05: Defensive JSON Extraction

## Goal

Parse useful JSON from imperfect local-model text.

## Build Steps

- [ ] Add pure extractor module with no model calls or filesystem writes.
- [ ] Add brace-walk JSON extractor.
- [ ] Strip markdown fences.
- [ ] Repair raw newlines in JSON strings.
- [ ] Repair escaped backticks.
- [ ] Add failure fixtures from `response.md` or raw model output artifacts.
- [ ] Keep proposal application out of this phase.

## Done Criteria

- [ ] Tests cover prose-wrapped JSON.
- [ ] Tests cover braces inside strings.
- [ ] Tests cover malformed local-model string control characters.
- [ ] Tests cover fixture text captured from prompt-run artifacts.
- [ ] Blog post documents observed parser failures.

## Notes

Phase 05 should consume text produced by Phase 04 artifacts, especially `response.md` and raw model output captured during smoke runs. Do not connect extraction to file writes, dry-run behavior, or proposal application yet; that belongs in Phase 10.
