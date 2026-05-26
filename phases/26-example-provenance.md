# Phase 26: Example Provenance

## Goal

Make example fixtures honest Kodr samples by recording generation provenance and requiring failed example generations to be retried through smaller Kodr slices.

## Scope

- [x] Add example provenance records.
- [x] Document that manually completing an example is not enough.
- [x] Add slice prompts for the CSV expense example after the one-shot failure.
- [x] Re-run Kodr on at least one smaller CSV slice and record the artifact.

## Done Criteria

- [x] Example docs explain the provenance expectation.
- [x] CSV example includes provenance for the failed one-shot and follow-up slice run.
- [x] Blog post documents the correction.
- [x] Tests still pass.
