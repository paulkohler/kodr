# Phase 123: The Corpus Becomes a Corpus

The json-extractor is the most battle-scarred module in kodr. Every model in
the 109–120 arc found a new way to corrupt its own output: gpt-oss dropped the
brace at a `files[]` boundary, gemma terminated strings with `<|"|>`
pseudo-tokens and collapsed key/value pairs, qwen emitted duplicate-key
clusters. Each got a structural or blanket decode rule, and — importantly — each
real broken response got saved as a replay fixture so the fix couldn't silently
regress.

But "saved as a fixture" had quietly decayed into five hand-written `it()`
blocks that were the same test five times: read a `.txt`, call
`extractProposal`, assert the recovered paths, assert one repair ruleId fired.
The provenance — *which model, which run, what exactly broke* — lived only in
code comments above each block. The corpus had no index. You couldn't count it,
couldn't audit it, and adding the sixth case meant copy-pasting the boilerplate
a sixth time.

That is backwards for the thing that is supposed to be kodr's honest record of
what local models get wrong.

## Manifest as source of truth

Phase 123 promotes the fixtures to a real corpus: `test/fixtures/corpus.json`,
one row per captured failure —

```json
{
  "id": "gemma-pseudo-token-multiblock",
  "model": "google/gemma-4-26b-a4b",
  "phase": "111-dogfood",
  "provenance": ".../gemma-smoke-2/.../raw-response.json",
  "failureMode": "two ```json blocks plus <|\"|> pseudo-tokens ...",
  "expectedPaths": ["wordfreq.mjs", "test/wordfreq.test.mjs"],
  "expectedRepairs": ["blanket-quote-token", "gemma-collapsed-key"]
}
```

A single data-driven test loops the manifest: for each entry, the extractor must
return a proposal, recover every `expectedPaths` file, and record every
`expectedRepairs` ruleId. A guard test asserts every manifest file exists on
disk and every id is unique, so the corpus can't drift from reality. The five
bespoke blocks collapsed into the loop; the manifest is now executable
documentation — reading it tells you what broke and how the extractor recovers
it, and the test proves that stays true.

Growth is now the smallest possible gesture: drop a `.txt`, add a row. No new
test code. That matters because the whole point of the corpus is that it keeps
growing as new models surface new corruptions.

## The new case

The seed addition is a gemma-4 response that does two bad things at once: it
emits two separate ````json```` blocks (multi-block narration, a phase-111
hazard) *and* terminates message content with `<|"|>` pseudo-tokens (a phase-113
hazard). The extractor recovers both `wordfreq.mjs` and its test through the
`blanket-quote-token` and `gemma-collapsed-key` repairs in sequence — a single
fixture that exercises two independent rules interacting, which is exactly the
kind of case that regresses quietly when you tune one rule and forget the other.

## No live run, on purpose

This phase ran no model. It didn't need to — the fixtures *are* real model
output, captured verbatim from runs under `~/src/kodr-testing/`. The replay is
deterministic and offline. That is the strength of an extractor corpus: the
expensive, nondeterministic part (getting a real model to corrupt its output in
a specific way) already happened and was preserved. Locking it in as a cheap,
fast, deterministic test is the whole return on having dogfooded so hard.

## What's still owed

This is the extractor half of "Bench-Driven Suite Growth." The other half — the
brownfield code-quality fixtures that measure whether the 121/122 guidance
actually reduces the mistakes the models make *in the code they write* — is the
harder, live-run-bearing measurement, and it's next. The extractor corpus
protects what the harness already learned to recover; the code-quality fixtures
will measure what the models still get wrong with the guidance in place.
