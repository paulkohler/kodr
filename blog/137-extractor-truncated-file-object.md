# Phase 137: The File That Disappeared Twice

The gpt-oss dogfood run for the `tasks` CLI task came back empty. `summary.json`
said `proposalFound:false`, `writeCount:0`, `writeError:ProposalMissingError`.
The model had apparently produced nothing useful.

It had produced something useful. A working `src/store.mjs` — load, save, JSON
round-trip, error handling. One file, returned cleanly in a bare-JSON envelope.
The harness lost it.

## What the artifacts actually said

`response.md` looked fine. The JSON envelope was there, the `files` array was
there, `src/store.mjs` was right where it should be. Nothing visibly wrong.

The raw wire content told a different story. `gptoss-truncated-envelope.json`
(975 bytes): `JSON.parse` failed at character 944 with "Expecting comma
delimiter." The model had emitted the file object's closing `}` as a newline
and a closing quote — then the files array `]` arrived without that brace:

```
...await writeFile(path, data, 'utf8');\n}\n"],"patches":[],"scratchpad":""}
                                           ^ this ] closes the files array
                              ^ the file object { (at pos 110) was never closed
```

`response.md` was a normalized rendering. It hid the truncation. The raw
artifact named it exactly.

## How the harness turned a missing brace into silent data loss

This is the part that matters: `extractJson` did NOT throw. It returned
`{"0":{level:"info",content:"Creating tasks CLI..."}}`.

The brace-walker (`braceWalkFrom`) started at the outer `{` (pos 0) and walked
until it hit the `]` at pos 944. The stack expected `}` (to close the file
object). Mismatch — threw `JsonExtractionError`. The retry mechanism moved on.

Next open: `[` at pos 26, the start of the `messages` array. `braceWalkFrom`
found a clean walk: the messages array closes properly at pos 99. Candidate:
`[{"level":"info","content":"Creating tasks CLI implementation and tests"}]`.
`JSON.parse` parsed it successfully. `extractJson` returned it.

That's a JavaScript array. `Object.keys([{a:1}])` returns `["0"]`. So the
result showed up as `{"0":{...}}` with no `files` key. `extractProposal` saw
no files, no patches, nothing that looked like an envelope — returned null.
`ProposalMissingError`. File lost.

There was no error, no warning, no indication that anything went wrong. The
extractor found valid JSON, parsed it, returned it. Exactly as designed — just
for the wrong candidate.

## The repair rule

The shape is precise: an object inside an array was never closed before the
array `]`. One missing brace. `applyUnclosedFileObjectRule` is a
position-aware scanner (same pattern as the qwen duplicate-key-cluster rule):
walk the text tracking `[` and `{` on a stack; when `]` is encountered but
the stack top is `{` (an unclosed object), insert `}` first.

Guards:
- Idempotent on valid JSON: when all objects are closed, the `]` always finds
  `[` on top of the stack, not `{`.
- Doesn't fire on string arrays: `["a","b","c"]` never pushes `{`.
- Scoped to the stack: fires only when a `{` was opened inside the current
  array (stack[N-1] is `{` and stack[N-2] is `[`).

The rule is applied to the **full text** before candidate enumeration. This is
the critical detail. The brace-walker couldn't produce the outer `{` as a
candidate at all — the corruption was at the outer level. Applying the repair
first lets `braceWalkFrom` succeed on the fixed text, producing the real
envelope as a candidate. That candidate is tried before the inner messages
array, so the correct result wins.

Only the unclosed-file-object rule is applied in this full-text pass. Not all
structural rules — the qwen duplicate-key-cluster rule (R5) would split
`{"files":[...],"files":[]}` before the duplicate-key check could reject it,
masking a real error. Each full-text structural pass is scoped to rules where
the full-text application is safe and necessary.

## The corpus grows

`test/fixtures/gptoss-file-object-unclosed.txt` is the verbatim 975-byte wire
capture. `corpus.json` entry `gptoss-file-object-unclosed` points at it with
provenance, failure mode, expected path (`src/store.mjs`), and expected repair
ruleId (`gpt-oss-unclosed-file-object`). The corpus replay test now covers
this shape alongside the five prior entries.

The out-of-scope finding: the model under-delivered (1 of 3 files, early
`finish_reason:stop`). That's a separate problem — a file-count guard or
continuation nudge when the proposal has fewer files than the task requested.
This phase only stops the harness from losing the file(s) the model did
produce.

## What changed

Before: a truncated envelope with one missing `}` caused silent data loss.
`extractJson` returned a valid-but-wrong inner array. The real file
disappeared with no error.

After: `extractJson` applies the unclosed-file-object repair to the full text
first, produces the repaired outer envelope as a candidate, and returns the
real envelope. The repair is recorded in `_extractionMeta.repairs` as
`gpt-oss-unclosed-file-object` — visible in `kodr why` forensics. The rule is
idempotent on valid JSON and does not touch string arrays.

The lesson: "response.md looks fine" is not evidence. The raw wire artifact
is evidence. When a run reports `proposalFound:false` for a model that usually
delivers, the first check is the 975 bytes at
`runs/<id>/raw-response.json` — not the normalized rendering.
