# Phase 121 — Model Code Quality (syntax gate + ESM contract)

## Motivation

The tool-channel arc (117–120) fixed the plumbing: across four models the
harness now captures, applies, verifies, and reports reliably. The runs that
still fail, fail on **the code the local models write**, not on the harness.
Recurring signatures from the validation record:

- gpt-oss emits `require.main === module` (CommonJS) inside `.mjs` ESM files
  (117-validation).
- devstral wrote a test with an illegal top-level `return` and called a
  nonexistent `node:test` API (`t.assert()`); its `--top N` argv parse used a
  regex that never matches separate argv tokens (119/120-validation).
- qwen produced off-by-one word counts (117-validation).

Two of these classes are *mechanical* and catchable before a run concludes:
syntax errors (illegal return, stray characters) and ESM/CommonJS confusion.
This phase adds the cheap, high-leverage backstops — a `node --check` syntax
gate and an ESM/Node-24 contract line — that turn "broken file lands, test
fails with a confusing downstream error" into "syntax error caught, named, and
fed to the heal loop." Logic bugs (off-by-one, bad regex) are out of scope —
those need tests, which the model already writes; this phase makes the
mechanical failures stop wasting heal turns.

Evidence: `process/failures.jsonl` phases 117/119/120-validation;
`src/verification-runner.mjs:53` (`node --check <file>` already allowlisted);
`src/app.mjs:3809` (`runPostWriteDiagnostics`, the post-write hook, runs after
apply and before the test); `src/system-env.mjs:76` (`renderBehavioursBlock`).

## Design principles

1. **Language-scoped, not global.** The syntax gate only checks `.mjs`/`.cjs`/
   `.js` writes; everything else is skipped. The ESM contract is injected only
   for Node/ESM workspaces. A Python or Go project sees neither — no pollution.
2. **Catch, name, feed the loop.** A syntax failure is recorded distinctly and
   fed to the existing heal loop as a clear `SyntaxError in <path>: <message>`,
   not buried in a downstream test failure. The model gets a precise signal.
3. **Cheap first.** Reuse `node --check` (already allowlisted) and the existing
   post-write/heal machinery. No new runtime surface, no new dependencies.
4. **Status still from verification.** The gate is a verification step, not a
   model self-report; it cannot make a broken run report success.

## Work items

### C1 — Syntax gate (`node --check` on written JS)

After writes are applied and before the test verification (the
`runPostWriteDiagnostics` neighbourhood in `src/app.mjs`, in the
`shouldApply && !writeError && !runError` branch), run `node --check` on each
applied file whose extension is `.mjs`/`.cjs`/`.js`:

- Produce `syntaxResult = { ok, failures: [{ path, message }], checked: N }`.
  Reuse `runVerification(cwd, 'node --check <path>', …)` (already allowlisted)
  or a small direct `node --check` spawn; skip non-JS and unreadable files.
- A syntax failure makes the run's verification fail: if `syntaxResult` has
  failures, treat it as a failed verification that **feeds the heal loop** —
  the repair diagnostic is the named syntax errors, not a confusing test
  error. Re-check after a heal attempt. The end-of-run `ok` is false while any
  written JS file fails `node --check`.
- Ordering: syntax gate before the test command. A file that does not parse
  cannot meaningfully be tested, so a syntax failure short-circuits to a clear
  syntax diagnostic rather than running `node --test` against unparseable code.
- Live-mode note: in `--apply-mode live` the files are already on disk; the
  gate runs the same way. In proposal mode the gate runs against the applied
  files in the verification cwd (same place the test runs today).

### C2 — ESM / Node-24 contract block (conditional)

A new short block, included in the system prompt **only for Node/ESM
workspaces**, naming the observed traps. Keep `renderBehavioursBlock` pure and
constant; add a separate `renderLanguageGuidanceBlock(facts)` (or similar)
that returns the ESM lines when the workspace signals Node/ESM, else `''`.
Signal: `package.json` with `"type": "module"`, or any `.mjs` file in the
workspace file map (computed once at session start → byte-stable prefix).

Content (terse, evidence-traceable, ≤4 lines):
- ESM only for Node.js: `import`/`export`, never `require` or
  `module.exports`; no top-level `return`. (gpt-oss CJS-in-ESM; devstral
  illegal return)
- Tests use the real `node:test` API: `import { test } from 'node:test'` and
  `node:assert`; do not invent methods like `t.assert()`. (devstral)
- CLI argv arrives as separate tokens (`--top` and `3` are two entries); parse
  flags accordingly. (devstral `--top` regex)

Respect the prompt-budget guard (≤2,900 chars total). Update prompt-prefix
fixtures deliberately; the block is part of the stable prefix when present.

### C3 — Forensics

`summary.json` gains `syntaxCheck` (`{ ok, checked, failures: [{path,message}] }`,
omitted when no JS files were written). `kodr why` surfaces it in the Edit
Application / verification step ("syntax check: 2 files ok" /
"syntax check FAILED: src/x.mjs — Illegal return statement"). The
language-guidance block's presence is implicit in the prompt artifacts; no
extra field needed.

## Testing

- C1 (tmp workspace, fake server): a write with a syntax error (illegal top
  level `return`, or a stray token) → `syntaxResult.ok === false`, the failure
  names the path + message, the run's `ok` is false, and the heal loop is
  invoked with the syntax diagnostic. A clean write → `syntaxResult.ok === true`
  and the test command still runs. Non-JS writes are skipped. The gate runs
  before the test (a syntactically broken file does not reach `node --test`).
- C1 live mode: same gate fires with `--apply-mode live`.
- C2: `renderLanguageGuidanceBlock` returns the ESM lines for a workspace with
  `package.json` `"type":"module"` or a `.mjs` file; returns `''` otherwise;
  the block is absent from a non-Node workspace prompt and present in a Node
  one; prompt-budget guard still holds; prefix stability fixtures updated.
- C3: `summary.syntaxCheck` present/shape; absent when no JS written; `kodr why`
  strings for pass and fail.
- Regression: runs with no JS writes and non-Node workspaces are byte-identical
  in prompt to phase 120; existing verification/heal tests stay green.
- Full suite, `npm run format`, `npm run check` green.

## Done criteria

- [x] C1: `node --check` syntax gate on written `.mjs`/`.cjs`/`.js`, before the
      test, failures named and fed to the heal loop, run `ok` false on syntax
      error.
- [x] C2: conditional ESM/Node-24 guidance block (Node/ESM workspaces only),
      pure/byte-stable, budget-guarded, prefix fixtures updated.
- [x] C3: `summary.syntaxCheck` + `kodr why` surfacing.
- [x] `process/failures.jsonl` / `process/decisions.jsonl` updated.
- [x] Blog post `blog/121-model-code-quality.md`.
- [x] NEXT.md: trim the "Model Code Quality" entry — syntax gate + ESM
      contract ship here; leave the per-model-family targeted-guidance half
      (option c) as the remaining candidate.
- [ ] Version bumped to 0.0.121; suite green; committed.
- [ ] Live validation (after the commit, sequential): devstral
      `--apply-mode live` greenfield — does the syntax gate catch its illegal
      `return` / bad `node:test` API and feed the heal loop a named error
      (vs the 120 run where the SyntaxError surfaced only via the model's own
      run_command)? Does the ESM block reduce the mechanical mistakes? Then a
      gpt-oss greenfield — does the ESM line cut the `require.main` CJS habit,
      and does the gate catch it if not? Record the mistake-class delta vs the
      117/120 runs (the metric is fewer mechanical failures reaching the user,
      not necessarily a green run).
