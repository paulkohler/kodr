# Phase 121: The Water, Not The Pipe

The tool-channel arc (117–120) fixed the plumbing. Across four models the
harness now captures, applies, verifies, and reports reliably. The runs that
still fail, fail on the code the local models write.

That shift was visible from the start of the arc. Phase 117-validation
noted that gpt-oss wrote `require.main === module` inside `.mjs` ESM files.
Phase 119/120-validation caught devstral with an illegal top-level `return`
in a test file, a call to a nonexistent `node:test` API (`t.assert()`), and
a `--top N` argv regex that operated on the full `process.argv.join(' ')`
string instead of on the separate entries. All three categories: syntax
errors, ESM/CommonJS confusion, and API hallucination.

The failures were in `process/failures.jsonl`. The harness was working
— it surfaced the failures honestly because status is computed from
verification, not declared by the model. The problem was what happened next.
The heal loop received a confusing downstream error — a `SyntaxError` buried
ten lines into a `node --test` backtrace — and had to infer from that what
the model actually did wrong. Expensive turns. Not always convergent.

Phase 121 addresses two of the three categories (logic bugs are out of
scope — those need tests, which the model already writes): the syntax gate
catches and names mechanical failures before the test command runs, and the
ESM contract block prevents the most common class of mistakes from landing
in the first place.

## The syntax gate (C1)

The central idea: `node --check` is already allowlisted in
`verification-runner.mjs` at line 53. It has been there since the
allowlisting was written. We just weren't using it proactively.

The gate (`src/syntax-gate.mjs`) runs after writes are applied and before
the test command. For every `.mjs`, `.cjs`, or `.js` file in `writeResult.writes`
it calls `node --check <path>`, collects stderr, and parses the
`SyntaxError: <message>` line. A failure produces `syntaxResult = { ok: false,
checked: N, failures: [{ path, message }] }`.

The ordering matters. If `syntax-gate.mjs` had run after the test command,
devstral's illegal `return` would still reach `node --test` and produce the
same buried backtrace. Running it first short-circuits to a clean
`SyntaxError in src/test.mjs: Illegal return statement` before the test
command fires.

The feed into the heal loop matters equally. The gate produces a
verification-shaped result via `syntaxResultToVerification` — the same
`{ ok, command, exitCode, stderr, stdout }` shape that `runVerification`
returns. The heal loop's repair prompt includes `tests.json`, which is now
the named syntax error. The model receives a precise signal rather than
a twenty-line test backtrace with no obvious failure point.

After healing, the test command runs against the now-syntactically-valid
file. If healing fails (the model can't fix the syntax in the allotted turns),
`summary.ok` is false.

## The ESM contract block (C2)

The syntax gate catches errors after they land. The ESM block tries to
prevent them.

`renderLanguageGuidanceBlock` in `system-env.mjs` returns four lines when
the workspace signals Node/ESM (`package.json` with `"type":"module"` or any
`.mjs` in the workspace file map), and returns `''` otherwise. The four
lines are:

```
# Node.js / ESM Contract
- ESM only: use `import`/`export`; never `require` or `module.exports`; no top-level `return` outside a function.
- Tests: `import { test } from 'node:test'` and `node:assert` — do not invent methods like `t.assert()`.
- CLI argv: `process.argv` entries are separate tokens (`--top` and `3` are two entries); parse flags with a token loop, not a single-string regex.
```

Each line is traceable to a real failure. The `require`/`module.exports` line
cites gpt-oss (117-validation). The `t.assert()` and top-level `return` lines
cite devstral (119-devstral). The argv token rule cites devstral's `--top`
regex (119/120-validation). These are not guidelines — they are transcribed
failure modes.

`renderBehavioursBlock` is not touched. That block is pure and constant —
no new lines go there. The ESM block is a fourth section in
`renderStableSection`, injected after behaviours/tools only when `isNodeEsm`
is true. Non-Node workspaces (Python, Go, Rust) see a byte-identical stable
section to phase 120. The byte-stability regression is unit-tested.

The detection is cheap: one `files.some(f => f.endsWith('.mjs'))` check
first, then a `JSON.parse` of up to 4 KB of `package.json`. Computed once
per session at `buildWorkspaceContext` time. The result is stable for the
prompt prefix cache.

## What this costs (C2 budget)

The ESM block is 391 characters. The prompt budget guard was raised from
3200 to 3600 for Node/ESM workspaces — still well under the 4096-token
LM Studio limit. Non-Node workspaces stay under 3200, unchanged.

The tradeoff is real: 391 chars of stable prefix for a predictable set of
local models on a predictable set of task types. The evidence says it's worth
it. If a future model family has different failure modes, the block is a
separate function with its own unit tests — easy to update or replace without
touching the core contract.

## Forensics surfacing (C3)

`summary.json` gains `syntaxCheck: { ok, checked, failures }`, omitted
entirely when no JS files were written (a Python run doesn't need it in its
summary). `kodr why` surfaces it in the Verification step before the test
result:

```
Verification    ok  syntax check: 2 files ok
Verification    ok  command=node --test passed=true
```

or:

```
Verification  fail  syntax check FAILED: src/wordfreq.mjs — Illegal return statement
Verification  skip  tests.json not found — verification not configured
```

The syntax step and the test-command step are both `Verification` phases —
the story now shows them as siblings, which is honest: both are verification,
running in sequence.

## What stays out of scope

Logic bugs — off-by-one counts, wrong algorithm, bad regex semantics — are
not catchable by a syntax gate or a contract line. The model writes a test
that passes on its own premises; the test just measures the wrong thing. That
class of failure needs evals (phase 100's brownfield suite) and possibly
per-model-family targeted guidance (the remaining half of the NEXT.md entry,
now explicitly left for a future phase). This phase does not touch it.

## The measurement

1217 tests before this phase. 1273 after (56 new: 26 syntax-gate, 20 in
system-env, 4 in forensics, 6 already in the C1/heal regression path through
app.test.mjs). All 1273 pass. The no-JS/non-Node prompt is byte-identical
to phase 120.

Live validation (devstral `--apply-mode live` and gpt-oss greenfield) is a
separate operator task. The metric is not "green run" — it's "fewer
mechanical failures reaching the user before the heal loop names them."
