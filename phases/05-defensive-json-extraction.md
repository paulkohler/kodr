# Phase 05: Defensive JSON Extraction

## Goal

Parse useful JSON from imperfect local-model text.

## Build Steps

- [ ] Add brace-walk JSON extractor.
- [ ] Strip markdown fences.
- [ ] Repair raw newlines in JSON strings.
- [ ] Repair escaped backticks.
- [ ] Add failure fixtures from real model output.

## Done Criteria

- [ ] Tests cover prose-wrapped JSON.
- [ ] Tests cover braces inside strings.
- [ ] Tests cover malformed local-model string control characters.
- [ ] Blog post documents observed parser failures.
