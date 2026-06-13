# Phase 123 — Extractor-Replay Corpus (growable + self-documenting)

## Motivation

The 109–120 arc generated a large real-failure record — gpt-oss `files[]`
boundary corruption, gemma `<|"|>` pseudo-tokens and collapsed keys, qwen
duplicate-key clusters — and the json-extractor was hardened against each
(phases 111/113/114/115/118). Five of those real responses are locked in as
offline replay fixtures (the `R5` block in `json-extractor.test.mjs`), but each
is a bespoke hand-written `it()` that duplicates the same shape: read fixture →
`extractProposal` → assert recovered paths → assert a repair ruleId. Adding a
new captured failure means copy-pasting another block. And the corpus has no
index — provenance lives only in code comments, so it is neither countable nor
honestly auditable as "what the local models actually get wrong" (the phase-100
ethos NEXT.md calls for).

This phase turns the ad-hoc fixtures into a **growable, self-documenting
corpus**: a `corpus.json` manifest (file + model + phase + provenance + failure
mode + expected paths + expected repairs) and a single data-driven replay test
that iterates it. Growth becomes "drop a `.txt`, add a manifest row" — no new
test code — and the manifest is executable documentation of the failure record.
It also seeds the corpus with one more real case: a gemma response that combines
`<|"|>` pseudo-tokens *and* multi-block narration.

This is the extractor-replay half of NEXT.md's "Bench-Driven Suite Growth";
the code-quality brownfield fixtures are a separate later phase.

Evidence: `test/json-extractor.test.mjs` R5 block; `test/fixtures/*.txt`;
`process/failures.jsonl` phases 111/113/114/115/118.

## Design principles

1. **Manifest is the source of truth.** Each replay fixture is one row in
   `test/fixtures/corpus.json`. The replay test loops the manifest; there are no
   per-fixture `it()` blocks to copy.
2. **Real output only.** Every fixture is a verbatim model response captured
   under `~/src/kodr-testing/` with provenance recorded — never hand-authored
   (honors the constitution: extraction evidence comes from real runs).
3. **Executable documentation.** The manifest records the failure mode and the
   expected repair ruleIds, so reading it explains *what* broke and *how the
   extractor recovers it*; the test proves the documentation stays true.
4. **Honest corpus.** A guard test asserts every manifest fixture file exists and
   ids are unique, so the corpus can't drift from disk.

## Work items

### C1 — Corpus manifest

Add `test/fixtures/corpus.json`: an array of
`{ id, file, model, phase, provenance, failureMode, expectedPaths,
expectedRepairs }`. Seed it with the four existing R5 fixtures
(`gptoss-stray-quote`, `gptoss-missing-brace-1`, `gptoss-missing-brace-2`,
`gemma-collapsed-key`) plus the new `gemma-pseudo-token-multiblock`.

### C2 — New fixture

`test/fixtures/gemma-pseudo-token-multiblock.txt` — a verbatim gemma-4 response
(provenance: `phase-111/gemma-smoke-2/.../raw-response.json`) that emits two
````json```` blocks and `<|"|>` pseudo-tokens; the extractor recovers both
`wordfreq.mjs` and `test/wordfreq.test.mjs` via the `blanket-quote-token` and
`gemma-collapsed-key` repairs.

### C3 — Data-driven replay + guard

Replace the bespoke R5 `it()` blocks with a single loop over `corpus.json`:
for each entry, `extractProposal(fixture)` must be non-null, every
`expectedPaths` entry must appear in the recovered files, and every
`expectedRepairs` ruleId must be recorded in `_extractionMeta.repairs`. Add a
guard test: each manifest `file` exists on disk, and `id`s are unique. Keep the
`DECODE_ARTIFACT_RULES` ordering tests (they assert rule semantics, not replay)
and the `R3` qwen split-rule tests (a different fixture/concern).

## Testing

- Data-driven replay passes for all manifest entries (≥5).
- Guard: every manifest file resolves; ids unique.
- New gemma fixture recovers both files with the two expected repairs.
- Full suite, `npm run format`, `npm run check` green.

## Done criteria

- [x] C1: `test/fixtures/corpus.json` manifest seeded with ≥5 entries.
- [x] C2: `gemma-pseudo-token-multiblock.txt` fixture (real provenance).
- [x] C3: data-driven replay loop replaces bespoke R5 blocks; guard test added.
- [x] `process/decisions.jsonl` updated.
- [x] Blog post `blog/123-extractor-replay-corpus.md`.
- [x] NEXT.md revised; version bumped to 0.0.123; suite green; committed.
- [x] No live model run required — the fixtures *are* real model output; the
      replay is deterministic and offline (noted explicitly).
