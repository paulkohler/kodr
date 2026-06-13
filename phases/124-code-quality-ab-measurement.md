# Phase 124 — Code-Quality A/B Measurement

## Motivation

Phases 121 and 122 shipped the Node/ESM contract block (and made it an
override-able builtin skill) to coach the local models away from their recurring
code-quality traps: CommonJS-in-ESM (`require`/`module.exports` in `.mjs`),
invented `node:test` API (`t.assert()`), illegal top-level `return`, and
argv-as-single-string parsing. Both phases explicitly deferred the same
question: **does the guidance actually reduce those mistakes?** The 121 operator
runs predated the greenfield-detection fix, so the block was absent when it
mattered, and the effect was never measured.

This phase builds the measurement and takes the first reading. The deliverable
is durable A/B infrastructure — a way to run the same task with the guidance
present and absent and compare the mistake-class rate — plus an honest first
datapoint.

Evidence: `process/failures.jsonl` phases 117/119/120/121-validation;
`src/eval-runner.mjs` (in-process `_runPrompt` per case); `evals/brownfield.json`.

## Design principles

1. **Hold everything else constant.** The only difference between arms is the
   presence of the guidance block. A `--no-language-guidance` flag forces the
   block off while leaving detection, tools, and the rest of the prompt
   byte-identical.
2. **No vacuous passes.** Each greenfield trap case pairs `files_exist` (the
   target must be written) with `content_absent` (the trap pattern must not
   appear). Without `files_exist`, a no-write would pass — `content_absent` is
   true for a missing file.
3. **Real models only.** Cases run against the local models through the existing
   eval harness; nothing is hand-authored.
4. **Honest reporting.** A null result is a result. The metric is the
   mistake-class delta, not a green run.

## Work items

### C1 — `--no-language-guidance` flag (A-arm)

`options.suppressLanguageGuidance` (default false), set by
`--no-language-guidance`. Threaded through `workspaceContextOptions` into
`buildWorkspaceContext`, where it forces the language block off (the workspace
is treated as non-Node for guidance purposes only; detection still runs and the
syntax gate is unaffected). `summary.languageGuidance` is absent in the A-arm.

### C2 — Code-quality eval suite + fixtures

`evals/code-quality.json` with greenfield generation cases and minimal
`type:module` fixtures:
- `cq-esm-cli`: "Create wordcount.mjs …" → `files_exist`, `content_absent`
  `require(`, `content_absent` `module.exports`.
- `cq-nodetest`: "Create sum.mjs + test/sum.test.mjs using node:test" →
  `files_exist`, `content_absent` `t.assert(`, `content_absent` `require(`.

### C3 — Measure

Run the suite with and without `--no-language-guidance` against the trap-prone
local models; compare per-assertion pass rates; record the delta.

## Result (first reading)

Infrastructure works end-to-end and the arms genuinely differ — verified from
the run artifacts: B-arm `summary.languageGuidance = {language:node,
source:builtin}` with the contract present in the prompt; A-arm marker absent,
contract absent.

The measurement is an **honest null on simple tasks**:

| model            | case        | A (guidance OFF) | B (guidance ON) |
|------------------|-------------|------------------|-----------------|
| gpt-oss-20b      | cq-esm-cli  | clean            | clean           |
| gpt-oss-20b      | cq-nodetest | clean            | clean           |
| devstral-2-2512  | cq-nodetest | clean            | clean           |

On these single-file greenfield tasks, neither model hits the CJS or
`t.assert()` traps with or without the block — so the guidance shows no
measurable effect here. The recurring traps in the 117–121 record appeared under
different conditions (multi-turn healing pressure, larger/edit tasks,
heal-context confusion), not clean first-shot generation. The takeaway: the
shared block's value (if any) must be measured on **trap-provoking** cases, not
easy ones — which sharpens the per-model-family-guidance question rather than
answering it.

## Done criteria

- [x] C1: `--no-language-guidance` flag suppresses the block; arms differ
      (verified in artifacts); unit-tested.
- [x] C2: `evals/code-quality.json` + fixtures; suite-validity test.
- [x] C3: live A/B against gpt-oss and devstral; result recorded honestly.
- [x] `process/decisions.jsonl` + `process/failures.jsonl` updated.
- [x] Blog post `blog/124-code-quality-ab-measurement.md`.
- [x] NEXT.md revised (trap-provoking cases as the next measurement step);
      version bumped to 0.0.124; suite green; committed.
