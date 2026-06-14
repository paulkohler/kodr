# Phase 140 — Trap-Provoking Measurement Fixtures

## Motivation

Phase 124 built the `--no-language-guidance` A/B apparatus and took a first
reading on simple greenfield tasks. Result: honest null. Neither gpt-oss-20b
nor devstral-2-2512 hit the `require()`/`t.assert()` traps on single-file,
clean-slate prompts — so the guidance showed no measurable effect.

NEXT.md diagnosed why: the traps from the 117–121 failure record live in
messier conditions — brownfield context, multi-file coordination, and heal-loop
second-guessing — not first-shot single-file generation. The shared block's
value (if any) must be measured there.

This phase adds brownfield and multi-file fixtures to `evals/code-quality.json`
that are specifically designed to provoke the `t.assert()` and `require()`
traps, runs them through the existing A/B apparatus, and records the delta.

## Design

Two new fixtures in `evals/code-quality.json`:

### `cq-brownfield-add-tests`

A project with existing ESM source (`src/counter.mjs`) and no tests. The model
must write `test/counter.test.mjs` using `node:test`. Brownfield context
(existing files, no test example to follow) is more trap-prone than greenfield:
the model pattern-matches on familiar test shapes rather than following an
in-context example.

Trap target: `t.assert()` — the invented node:test API.

### `cq-multi-file-esm`

A blank project that asks for three coordinated files: a `Store` module, a
`Cache` module that imports `Store`, and tests for `Cache`. Multi-file
coordination under a single prompt is more trap-prone because:
- The model must manage multiple import/export chains
- It has more opportunities to slip into a CJS pattern on one file
- It's writing source AND tests in the same turn

Trap targets: `require()` in any of the three files, `t.assert()` in tests.

## A/B measurement

Run both new cases (plus existing cq-* cases as controls) with and without
`--no-language-guidance` using `kodr eval --suite evals/code-quality.json
--record`. Compare pass rates on the trap assertions with `kodr evals --json`.

## Files changed

- `evals/fixtures/cq-brownfield-add-tests/` — package.json, src/counter.mjs, README.md
- `evals/fixtures/cq-multi-file-esm/` — package.json, README.md
- `evals/code-quality.json` — two new cases

## Done criteria

- [x] `cq-brownfield-add-tests` fixture and `code-quality.json` entry.
- [x] `cq-multi-file-esm` fixture and `code-quality.json` entry.
- [x] Suite-validity test still passes.
- [x] A/B run completed (both arms); result recorded honestly — null on all 4 runs against qwen3.6-35b-a3b.
- [x] `process/decisions.jsonl` entry.
- [x] Blog post `blog/140-trap-provoking-fixtures.md`.
- [x] NEXT.md: Trap-Provoking item removed; Per-Model-Family updated with findings.
- [x] Version bumped; format + check + tests pass; committed.
