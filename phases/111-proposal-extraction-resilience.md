# Phase 111 — Proposal Extraction Resilience

## Motivation

Dogfooding round 2 (qwen3.6) and the gemma-4 smoke test exposed that proposal
extraction is the single most brittle layer in the harness. Three different
models failed three different ways, and in every case the model's response
contained recoverable substance that the extractor discarded:

- **gemma-4 multi-block narration** — the model emitted six ```json blocks
  simulating step-by-step execution. Block 1 was a planning envelope with
  `files: []`; blocks 2–3 held the real `wordfreq.mjs` and test file.
  `extractJson` returns the *first* candidate that parses, so the planning
  block won and zero files were written. Evidence:
  `~/src/kodr-testing/phase-111/gemma-smoke-1/.kodr/runs/2026-06-12T06-28-30.378Z/response.md`.
- **Candidate enumeration aborts on one bad region** — `braceWalk` throws
  (`Unclosed JSON candidate`, `Mismatched JSON delimiters`) from *inside*
  `candidateTexts`, outside the per-candidate try/catch in `extractJson`. One
  malformed brace region destroys all fenced candidates too. This killed the
  gemma repair turn (`repairs/repairs.json`: stopReason `invalid_proposal`,
  error `Unclosed JSON candidate`).
- **Fence pairing is suspect** — the gemma response has six ` ```json `
  opening markers but the `/```(?:json)?\s*([\s\S]*?)```/` pattern pairs only
  three blocks. Likely interleaved or nested fences break the open/close
  alternation. Needs investigation against the real artifact.
- **Nested duplicate keys silently drop files** — round 2's greenfield
  logstats run had a `files[]` entry with two `path` keys; `JSON.parse` keeps
  the last and the first file silently vanished.
  `assertNoDuplicateTopLevelKeys` only guards depth 1.
- **qwen3.6 reasoning-then-silence** — the model plans a complete
  implementation in reasoning tokens (4,117 in one run), then emits ~2 chars
  of content on a `stop` turn. No retry, no clear surface message. Evidence:
  `~/src/kodr-testing/phase-111/brownfield-wordfreq-feature-1/` (run.log:
  "2 response chars", finish_stop).

Principle, extending phase 110's: the model's response is evidence, not a
single parse target. Extraction should recover every valid proposal fragment
the response contains, and when there is genuinely nothing, say so loudly and
give the model one chance to correct.

## Work items

### E1 — Candidate enumeration never aborts

`candidateTexts` must catch `braceWalk` errors and skip the brace candidate
instead of throwing. After a failed walk, attempt the next `{`/`[` after the
failed open index (bounded — a handful of retries, not a full scan) so one
garbage region early in the text does not hide a valid object later.
`findJsonText` keeps its current throw-when-nothing-found contract.

### E2 — Multi-candidate proposal merge

When more than one candidate parses as a valid proposal envelope, merge them
instead of taking the first: concatenate `files`, `patches`, and `messages`
across candidates in document order, last-wins per `path` for `files`;
scratchpad/status from the last envelope that sets them. Single-envelope
responses behave exactly as today. Record extraction metadata
(`candidateCount`, `proposalCount`, `merged`) so it lands in run artifacts and
`kodr why` can show "proposal assembled from N blocks".

### E3 — Duplicate-key detection at all depths

Extend the duplicate-key guard from top-level-only to every object in the
candidate (per-object key sets, tracked through the existing depth walk). The
error must name the duplicated key so the repair prompt can steer:
`Duplicate JSON key: path`.

### E4 — Empty-final-turn recovery

When the final turn ends with finish reason `stop`, near-empty content
(fewer than ~20 non-whitespace chars), and no extractable proposal: send one
nudge retry ("Your last message was empty. Output the single JSON proposal
envelope now.") before declaring failure. On final failure, the run output
must state `Proposal: MISSING — response was empty (N chars)` instead of a
bare `finish_stop`, and the summary must carry the same fact for forensics.
One retry only — this must not become a loop.

### E5 — Fence pairing investigation and fix

Reproduce the 6-markers/3-blocks discrepancy against the saved gemma
response.md. Fix `fencedJsonBlocks` so every fenced json block is enumerated
(line-anchored fences are the likely shape of the fix). Add the real response
as a test fixture (trimmed if needed, provenance noted in the test).

## Testing

- Unit tests in `test/json-extractor.test.mjs` (or alongside existing
  extractor tests) for E1/E2/E3/E5, including fixtures derived from the real
  gemma and qwen artifacts under `~/src/kodr-testing/phase-111/` — copy the
  relevant response text into the test as fixture strings with a provenance
  comment. These are harness-failure fixtures, not generated examples, so
  embedding them in tests is correct.
- Orchestration-level test for E4 against the fake model server: first turn
  returns near-empty stop, nudge turn returns a valid envelope → run
  succeeds; both turns empty → run fails with the MISSING message.
- Full suite, `npm run format`, `npm run check` green.

## Done criteria

- [x] E1: braceWalk failure cannot abort candidate enumeration; test proves a
      valid fenced block is extracted despite a malformed brace region.
- [x] E2: gemma response.md fixture yields a proposal containing the real
      files from blocks 2+; extraction metadata recorded.
- [x] E3: nested duplicate `path` key raises `Duplicate JSON key: path`
      instead of silently dropping a file.
- [x] E4: near-empty stop turn triggers exactly one nudge retry; failure
      output says `Proposal: MISSING — response was empty (N chars)`.
- [x] E5: all six fenced blocks in the gemma fixture are enumerated.
- [x] `process/failures.jsonl` / `process/decisions.jsonl` updated.
- [x] Blog post `blog/111-proposal-extraction-resilience.md`.
- [x] NEXT.md entries shipped by this phase deleted (FIFO).
- [x] Version bumped to 0.0.111; suite green; committed.
