# Phase 137 — Extractor: Recover a Truncated File-Object Envelope

## Motivation (a real gpt-oss capture, lost cleanly-but-totally)

A phase-137 model-coverage dogfood ran the 3-file ESM `tasks` task against
`openai/gpt-oss-20b`. It under-delivered (1 of 3 files, `finish_reason: stop`),
which is a model-quality issue — but the harness then lost even that one file to
an **extractor bug**.

The model emitted a single bare-JSON envelope (no fence, no prose) for
`src/store.mjs`. The envelope is structurally truncated: the file object's
closing `}` is missing right before the `files` array `]`:

```
...await writeFile(path, data, 'utf8');\n}\n"],"patches":[],"scratchpad":""}
                                         ^ content-string close
                                          ^ files array ] — the file-object } is MISSING
```

i.e. `"files":[{"path":"...","content":"..."  ]` — object never closed.

The real capture is saved at
`~/src/kodr-testing/phase-137/gptoss-truncated-envelope.json` (975 bytes). Run
artifact: `~/src/kodr-testing/phase-137/tasks-gptoss/.kodr/runs/<id>/`
(`summary.json`: `proposalFound:false`, `proposalChannels.envelope:0`,
`writeError: ProposalMissingError`, `writeCount:0`).

**The bug:** `extractJson` does NOT throw on this input — it returns junk
`{ "0": ... }` (files: 0). Some earlier repair rule "succeeds" into a malformed
object instead of recovering the envelope, so `extractProposal` sees no `files`
and reports `ProposalMissingError`. A structurally-truncated envelope should be
**recovered** (insert the missing `}`) or **cleanly rejected** — never silently
mangled into a parseable-but-wrong object whose one real file is dropped.

`test/fixtures/corpus.json` already has `gptoss-missing-brace-1` and
`gptoss-missing-brace-2`; this is a third, distinct shape (an object inside an
array left unclosed before the array close) that the current structural rules in
`repairJsonText` don't cover.

## Design principles

1. **Corpus-first, test-driven.** Add the real capture as a new corpus entry and
   make the extractor recover it; the existing corpus replay is the regression
   guard (phase 123 discipline). No blind heuristics — every rule change is
   validated against the whole corpus.
2. **Precise rule, no regressions.** The structural repair must fire ONLY on the
   genuine "unclosed object before `]`" shape and must not alter any input that
   already parses or that other rules already handle. The full extractor test
   suite + corpus replay MUST stay green.
3. **Recover the real envelope, not junk.** After repair, the parsed value must
   be the actual envelope (`status`, `files:[{path, content}]`, `patches`,
   `scratchpad`) — not the current `{"0":...}`. Investigate why the current
   chain yields `{"0":...}` (a prior rule firing first) and ensure the structural
   rule produces the correct object. If a correct recovery is genuinely not
   safely achievable, the fallback is a clean throw (so `extractProposal`’s
   existing missing-proposal path is honest) — but recovery is the goal since
   the only corruption is one missing brace.

## Work items

### A — Corpus fixture (`test/fixtures/corpus.json`)

- Add an entry (e.g. `gptoss-file-object-unclosed` / `gptoss-missing-brace-3`)
  with the real 975-byte capture as `input`, a provenance comment/field pointing
  at the artifact path, and the expected recovered shape (1 file, path
  `src/store.mjs`, `patches: []`). Follow the existing entry schema exactly.

### B — Structural repair rule (`src/json-extractor.mjs` / `repairJsonText`)

- Add a structural rule (repair path only — it runs after a normal parse already
  failed) that closes an unclosed object immediately before an array close: the
  `"<value>" ]` → `"<value>" } ]` shape, scoped so it only applies inside an
  array of objects and only when the brace balance confirms an object is open.
  Give it a `ruleId` so its firing is counted in the repair metadata (matching
  the existing rule bookkeeping).
- Ensure the new rule composes with the existing chain so the result is the real
  envelope, and that whatever currently produces `{"0":...}` no longer wins for
  this input.

### C — Forensics (light, optional)

- The repair-rule counts already flow into extraction metadata (phase 128). The
  new ruleId will appear in `summary.extraction` / `kodr why` for runs it
  salvages; no schema change.

## Testing (`node:test`, no live model)

- The corpus replay test (whatever drives `corpus.json`) now includes the new
  entry and asserts the recovered envelope has 1 file at `src/store.mjs`.
- A direct `extractProposal`/`extractJson` unit test on the capture: returns a
  proposal with exactly one file, no `{"0":...}` artifact.
- A guard test: the new structural rule does NOT alter a well-formed envelope
  (idempotent on valid input) and does not fire on an array of strings like
  `["a","b"]` (no spurious brace insertion).
- Full `npm test` green — **especially the entire extractor/corpus suite** (no
  regression on `gptoss-missing-brace-1/2`, `gemma-*`, stray-quote, etc.).
  `npm run format`, `npm run check`.

## Out of scope (record in NEXT.md, do not implement here)

- **gpt-oss under-delivery** (1 of 3 files, early `finish_reason: stop`): a
  model-behavior / partial-delivery problem. A file-count guard or a
  continuation nudge when a valid proposal has fewer files than the task
  requested is a separate phase. This phase only stops the extractor from losing
  the file(s) the model *did* produce.
- gpt-oss channel selection (envelope vs native tools) — separate.

## Done criteria

- [x] A: real capture added to `corpus.json` with provenance + expected shape.
- [x] B: structural rule recovers the truncated file-object envelope into the
      real proposal (1 file), with a counted `ruleId`.
- [x] Tests: corpus replay + direct extract + idempotence/no-spurious-fire
      guard. Full extractor/corpus suite and full `npm test` green; format +
      check green.
- [x] `process/failures.jsonl`: the gpt-oss capture (truncated envelope silently
      mangled to `{"0":...}`, one valid file lost) — and note the operator's
      mis-analysis path (response.md looked valid; the raw wire failed json.loads
      at char 944; confirm against the raw artifact, not the normalized
      response.md).
- [x] `process/decisions.jsonl`: recover-or-reject (never silently mangle) a
      structurally-truncated envelope; corpus-replay as the regression guard.
- [x] Blog post `blog/137-extractor-truncated-file-object.md`.
- [x] NEXT.md: add the out-of-scope gpt-oss under-delivery / file-count-guard
      item; version bumped to 0.0.137; roadmap line checked; committed.
