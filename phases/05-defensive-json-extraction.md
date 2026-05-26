# Phase 05: Defensive JSON Extraction

## Goal

Parse useful JSON from imperfect local-model text.

## Build Steps

- [x] Add pure extractor module with no model calls or filesystem writes.
- [x] Add brace-walk JSON extractor.
- [x] Strip markdown fences.
- [x] Repair raw newlines in JSON strings.
- [x] Repair escaped backticks.
- [x] Add failure fixtures from `response.md` or raw model output artifacts.
- [x] Keep proposal application out of this phase.

## Done Criteria

- [x] Tests cover prose-wrapped JSON.
- [x] Tests cover braces inside strings.
- [x] Tests cover malformed local-model string control characters.
- [x] Tests cover fixture text captured from prompt-run artifacts.
- [x] Blog post documents observed parser failures.

## Notes

Phase 05 should consume text produced by Phase 04 artifacts, especially `response.md` and raw model output captured during smoke runs. Do not connect extraction to file writes, dry-run behavior, or proposal application yet; that belongs in Phase 10.
