# Phase 05: Defensive JSON Extraction

Local models often wrap useful JSON in prose, markdown fences, or slightly malformed strings.

## Decision

Add a pure extractor module before connecting JSON to writes.

## Design

The extractor tries fenced `json` blocks first, then brace-walks the text while respecting quoted strings. Before parsing it repairs raw newlines, carriage returns, and tabs inside JSON strings, and converts escaped backticks back to literal backticks.

## Observed Failures

The tests preserve the failures this phase is meant to survive:

- prose before and after JSON
- fenced markdown JSON
- braces inside string values
- raw newlines inside JSON strings
- escaped markdown backticks

## Verification

```sh
npm run format
npm test
npm run check
```
