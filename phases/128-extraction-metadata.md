# Phase 128 — Extraction Metadata Into Run Artifacts

## Motivation

The json-extractor computes `_extractionMeta` on every proposal — how many JSON
candidates it saw, how many envelopes it merged, and which structural/decode
repairs fired (phases 111/115/118). Only the `channels` slice of that metadata
ever reached `summary.json` (as `proposalChannels`); the candidate/proposal
counts, the merged flag, and the repair ruleIds were computed and discarded.

That is exactly the data the forensics surfaces want. `kodr why` should be able
to say "proposal assembled from 2 blocks; repairs: gpt-oss-missing-brace×1", and
`kodr trends` (phase 127) should be able to say which corruption the local models
hit most across the whole archive. This phase threads `_extractionMeta` into the
run summary and surfaces it in both forensics views.

Evidence: `src/json-extractor.mjs:187` (`_extractionMeta`); NEXT.md "Extraction
Metadata Into Run Artifacts"; phase-123 corpus; phase-127 trends.

## Work items

### C1 — `summary.extraction`

A small `extractionSummary(proposal)` helper lifts `{ candidateCount,
proposalCount, merged, repairs? }` from `proposal._extractionMeta` and is written
to `summary.extraction` at both summary-build sites (the proposal-error path and
the main path). Omitted entirely when there is no proposal/metadata.

### C2 — `kodr why`

The Proposal Extraction phase gains a step when the proposal was assembled from
multiple blocks and/or needed repairs: "assembled from N blocks; repairs:
ruleId×count". Silent for clean single-block extractions.

### C3 — `kodr trends`

`computeTrends` aggregates `extractorRepairs` (ruleId → total count) and
`mergedExtractionCount` across runs; the report renders an `extraction:` section
ranking which repair rule fired most. This is the archive-wide view of what the
local models corrupt — the live complement to the phase-123 replay corpus.

## Testing

- C3: `computeTrends` sums repair counts across runs and counts merged
  extractions.
- C2: `kodr why` emits the extraction step for a merged+repaired summary.
- Live: a real gpt-oss run writes `summary.extraction`
  (`{candidateCount:1, proposalCount:1, merged:false}`).
- Full suite, format, check green.

## Done criteria

- [x] C1: `summary.extraction` written at both summary-build sites.
- [x] C2: `kodr why` Proposal Extraction surfacing (merged/repairs).
- [x] C3: `kodr trends` extractor-repair frequency + merged count.
- [x] Tests (trends aggregation + forensics step); live summary check.
- [x] `process/decisions.jsonl` updated.
- [x] Blog post `blog/128-extraction-metadata.md`.
- [x] NEXT.md revised; version bumped to 0.0.128; suite green; committed.
