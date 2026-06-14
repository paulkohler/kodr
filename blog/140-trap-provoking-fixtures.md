# Phase 140: Another Honest Null

Phase 124 got a null on simple greenfield tasks: gpt-oss and devstral didn't
hit the `require()`/`t.assert()` traps on clean single-file prompts, with or
without the lang:node guidance block. The diagnosis was clear — the traps appear
under pressure, not at rest.

So phase 140 built the pressure.

## The fixtures

Two new cases added to `evals/code-quality.json`:

**`cq-brownfield-add-tests`** — an existing ESM Counter class, no tests, and a
blunt prompt: "Write tests for it in test/counter.test.mjs." No mention of
node:test, no mention of ESM. The model sees `package.json` with `type: module`
and `src/counter.mjs` with `import`/`export`. It has to infer the right test
framework and module format from context.

**`cq-multi-file-esm`** — a blank project with three files to create: a Store
class, a Cache that wraps it, and tests. The prompt names the files and
describes the behavior. Nothing about ESM or node:test. Multi-file coordination
under a single implicit prompt.

Both fixtures check for clean code: `content_absent` on `require()` and
`t.assert()`, plus `tests_pass` to confirm the code actually runs.

## The result

Four runs: A-arm (no guidance), B-arm (with guidance), against qwen3.6-35b-a3b.
All pass. Score 1.00 on every run.

qwen3.6 writes clean ESM + node:test on both brownfield and multi-file tasks,
with or without the lang:node block in the system prompt. The guidance makes no
measurable difference for this model.

## What this means

The traps in the 117–121 failure record — `require.main` in `.mjs`, `t.assert()`,
`module.exports` — were associated with gpt-oss-20b and devstral, not qwen3.6.
The A/B apparatus is working: the arms genuinely differ (B-arm carries the
guidance block, A-arm doesn't), the assertions catch the patterns, and the
fixture runs real model generation through the harness. The null is not a
test-design failure — it's a finding about which model the guidance actually
helps.

The shared `lang:node` block was written in response to gpt-oss's CJS habit and
devstral's `t.assert()` tendency. Those models aren't in the current daily
rotation. The block is still cheap to keep — it doesn't hurt qwen — but measuring
its effect requires running against the models that need it.

The next measurement would run `kodr eval --suite evals/code-quality.json` with
gpt-oss-20b or devstral and compare trap rates. That's per-model-family guidance
territory, unblocked now that the fixtures exist.

## The fixture record

These two cases join `cq-esm-cli` and `cq-nodetest` in `evals/code-quality.json`
as durable trap-check fixtures. Even if today's measurement is null, they'll
catch regressions — if a future model or guidance change introduces `require()` in
a `.mjs` output, the suite will see it.
