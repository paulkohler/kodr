# Phase 147 — Extractor: Recover a Token-Truncated Envelope Tail

## Motivation (a real qwen capture, lost cleanly-but-totally)

A 2026-06-15 examples-trial ran a 4-file greenfield Markdown-to-HTML converter
task against `qwen/qwen3.6-35b-a3b`. The model hit its output-token limit and
the stream ended **mid-envelope**: the root object `{` and the `files` array `[`
were opened, the final file object was closed with `}`, but the `files` array
`]` and the root `}` were never emitted. A trailing `</parameter>` token (a
stray jinja/tool artifact) followed the last `}`.

The real capture is at
`~/src/kodr-testing/md-converter-qwen/.kodr/runs/2026-06-14T21-02-23.704Z/`
(`raw-response.json` → `responses[-1].choices[0].message.content`, 6763 chars;
`summary.json`: `proposalFound:false`, `writeError: ProposalMissingError`,
`writeCount:0`). Saved verbatim as `test/fixtures/qwen-truncated-envelope.txt`.

**The bug:** `extractProposal` returns `null` (→ `ProposalMissingError`). The
brace-walker (`braceWalkFrom`) cannot close the truncated root object, so it
never produces the outer envelope as a candidate; the only parseable candidates
are inner fragments (the `messages` array, a `{level,content}` object) that are
not envelopes. Every file the model produced is discarded.

This is the third distinct truncation shape in the extractor's history and the
one the `examples-trial` failure (`process/failures.jsonl`, 2026-06-15) flagged
as needing "R6 or extend R4":

- **R4 `gpt-oss-unclosed-file-object`** (phase 137): a file object's `}` missing
  *before* the array `]`. The array and root were intact. Does **not** fire here
  (the file object *is* closed; the `]` and root `}` are simply absent).
- **R5 `qwen-duplicate-key-cluster`** (phase 118): all files emitted as duplicate
  keys inside one object. This capture *also* has this shape — but R5 alone
  leaves the envelope unclosed, so it still does not parse.

The combination here is **R5 (split the duplicate-key cluster) + R6 (close the
truncated tail)**. Confirmed offline: either order recovers all four files.

## Design principles

1. **Corpus-first, test-driven.** Add the real capture as a corpus entry; the
   existing manifest-driven replay (phase 123) is the regression guard. Every
   prior corpus row must stay green.
2. **Recover the elements the model produced — never mangle.** R6 may only close
   the tail when there is a completed, anchorable element to close back to. If no
   element ever completed inside the open container, R6 does **not** fire (a
   half-written file is not a produced file). This keeps the phase-137
   "recover-or-reject, never silently mangle" rule.
3. **Fire only on genuine truncation; idempotent on valid JSON.** R6 only acts
   when the structural stack is still open at end-of-text or at the first
   structural-level garbage char (e.g. `</parameter>`). Balanced JSON — including
   prose-wrapped JSON and multi-block responses — returns unchanged.
4. **Strings are opaque.** A `<`, `]`, `}` etc. inside a string value never
   triggers anything; the rule tracks string/escape state like its siblings.

## Work items

### A — Corpus fixture (`test/fixtures/`, `corpus.json`)

- `qwen-truncated-envelope.txt`: the verbatim 6763-char capture (already saved).
- A manifest row: `id: qwen-truncated-envelope`, provenance pointing at the run
  artifact, `failureMode` describing the truncated tail + duplicate-key cluster,
  `expectedPaths` = the four files, `expectedRepairs` =
  `["qwen-duplicate-key-cluster", "truncated-envelope-tail"]`.

### B — R6 rule (`src/json-extractor.mjs`)

- `applyTruncatedEnvelopeRule(text) → { text, fixCount }`: a position-aware
  single-pass scanner tracking string/escape state and a stack of expected
  closers. It records `lastSafeEnd` = the index after the most recent container
  close (`}`/`]`) that left the stack non-empty, snapshotting the stack there.
  It stops at end-of-text or at the first structural-level garbage char while the
  stack is non-empty, and — only if a safe anchor exists — returns
  `text.slice(0, lastSafeEnd)` + the snapshot closers (reversed). `ruleId`:
  `truncated-envelope-tail`.
- Wire into `applyStructuralRules` **after R5** so the duplicate-key split runs
  first and R6 closes the resulting tail.
- Wire into the `extractJson` full-text pre-pass **after R4**, mirroring R4's
  re-enumeration so the now-closeable outer object becomes a candidate. (Per
  `extractJson`'s documented policy it still does **not** apply R5 there, so a
  pure-truncation input recovers via `extractJson`; the duplicate-key+truncation
  combo recovers via `extractProposal`'s structural second pass.)
- Add to `DECODE_ARTIFACT_RULES` (type `structural`, before blanket rules) and
  extend the rule-ordering comment + provenance block.

### C — Forensics

- Repair counts already flow into `_extractionMeta.repairs` (phase 128); the new
  `truncated-envelope-tail` ruleId appears in `summary.extraction` / `kodr why`
  for salvaged runs. No schema change.

## Testing (`node:test`, no live model)

- Corpus replay includes the new row and asserts all four files recover with both
  expected repairs recorded.
- A direct `extractProposal` test on the capture: four files, no `null`,
  `truncated-envelope-tail` recorded.
- A direct `extractJson` test on a **pure-truncation** input (no duplicate keys):
  recovers the closed object.
- Guard tests: R6 does **not** fire on valid JSON (idempotent), on prose-wrapped
  JSON, or on a string value containing a stray `<`/`]`; and does **not** fire
  when no element completed inside the open container (clean miss, not a mangle).
- Full `npm test`, `npm run format`, `npm run check` green (version → 0.0.147).

## Out of scope (NEXT.md, not here)

- qwen output-token-limit truncation as a *model/transport* problem (raising
  `max_tokens`, continuation-on-length for the envelope channel) — separate from
  recovering the bytes that did arrive.
- The stray `</parameter>` jinja/tool artifact in qwen output — R6 tolerates it
  as trailing garbage; understanding why qwen emits it is a separate inquiry.

## Done criteria

- [x] A: real capture in `corpus.json` with provenance + expected shape/repairs.
- [x] B: `applyTruncatedEnvelopeRule` recovers the truncated tail with a counted
      `truncated-envelope-tail` ruleId; composes with R5; idempotent on valid JSON.
- [x] Tests: corpus replay + direct extract + idempotence/no-spurious-fire/
      no-anchor guards. Full suite (1421) + format + check green.
- [x] `process/failures.jsonl`: the qwen truncated-tail capture (ProposalMissing,
      all files lost) and the duplicate-key+truncation composition finding (plus
      the self-inflicted `<|"|>` regression and its blanket-normalize fix).
- [x] `process/decisions.jsonl`: anchor-on-last-completed-element recovery; R6
      after R5 in the structural chain; extractJson pre-pass keeps its no-R5 policy.
- [x] Blog post `blog/147-extractor-truncated-envelope.md`.
- [x] NEXT.md examples-trial R6 item resolved; roadmap line checked; version
      bumped to 0.0.147; committed.
