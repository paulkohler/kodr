# Phase 128: Stop Throwing Away What the Extractor Knows

Every proposal kodr extracts comes with a story the extractor already wrote down
and then mostly threw away. `_extractionMeta` records how many JSON candidates
the response contained, how many envelopes got merged into one proposal, and —
the interesting part — which structural and decode repairs had to fire to
recover the thing. gpt-oss dropped a brace; the `gpt-oss-missing-brace` rule
patched it. gemma emitted a pseudo-token; `blanket-quote-token` stripped it. The
extractor knew all of this at extraction time.

But only one slice of that metadata — the channel breakdown — ever made it into
`summary.json`. The counts and the repair list were computed and discarded on
the way out. So the run artifacts couldn't tell you that a proposal had been
stitched together from three blocks, or that it only survived because two repair
rules fired. The most interesting thing about a corrupt-but-recovered response
was invisible the moment the run ended.

## Threading it through

This phase is mostly plumbing, and that's the point — the data already existed.
A small helper lifts `{ candidateCount, proposalCount, merged, repairs }` out of
`_extractionMeta` and writes it to `summary.extraction`, omitted entirely when
there's nothing to say (no proposal, no metadata). Then two surfaces read it:

`kodr why` gains a line in the Proposal Extraction phase when a proposal was
assembled from multiple blocks or needed repairs — "assembled from 2 blocks;
repairs: gpt-oss-missing-brace×1". A clean single-block extraction stays silent,
so the line only appears when it's telling you something.

`kodr trends` (from phase 127) gains an `extraction:` section that aggregates
repair frequency across the whole archive: which rule fired most, how many runs
needed multi-block assembly. That turns the extractor's per-run notes into a
fleet-wide signal — the archive-side complement to phase 123's replay corpus.
The corpus locks in *that* the extractor recovers a specific captured failure;
trends shows *how often* those failures actually happen in practice, and which
model-corruption is worth hardening against next.

## Why it matters more than it looks

The extraction layer absorbed an enormous amount of work across phases 111–118 —
every model found a new way to mangle its output, and each got a rule. But that
work was only legible through the test suite and the saved fixtures. In a real
run, a recovered proposal looked identical to a clean one; the repair was a
silent save. Now the save is on the record. When `kodr trends` says
`gpt-oss-missing-brace` fired in a fifth of recent runs, that's a concrete,
measured argument for where the next extraction effort should go — or, if a
model's repair count drops to zero after a prompt change, evidence that the
change helped. The metadata was always there. Now it's data you can act on.
