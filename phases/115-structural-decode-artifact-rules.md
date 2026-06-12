# Phase 115 — Structural Decode-Artifact Rules

## Motivation

Phase 112 added `DECODE_ARTIFACT_RULES` with one blanket rule (`<|"|>` → `"`).
Real runs have since produced two corruption families the blanket rule cannot
fix, and both killed otherwise-valid envelopes:

1. **gemma role-B collapse** — gemma sometimes collapses `"key":"` into
   `"key:<|"|>`. The blanket replace yields `"key:"value` — still unparseable.
   The structural form `"<key>:<|"|>` → `"<key>":"` must run *before* the
   blanket rule. Evidence:
   `~/src/kodr-testing/phase-113/greenfield-logstats-1/.kodr/runs/2026-06-12T09-09-49.853Z/raw-response.json`.
2. **gpt-oss files[] boundary corruption** — three runs out of three corrupted
   the same `files[]` object boundary by exactly one character, in two
   observed shapes (verbatim from saved raw responses):
   - `"},"{"path":` — stray `"` before `{`
     (`phase-113/transport-validation-gptoss/.kodr/runs/2026-06-12T11-41-44.327Z/`)
   - `"},"path":` — missing `{` (twice:
     `phase-114/ab-gptoss-newprompt/.kodr/runs/2026-06-12T12-07-32.733Z/` and
     `phase-114/ab2-gptoss/.kodr/runs/2026-06-12T12-25-15.658Z/`)

Related from the same runs: gpt-oss called a nonexistent `write_file` tool
4–5 times per run despite an explicit prompt line saying no write tool
exists. The unknown-tool error feedback should steer the model back to the
envelope, the same pattern as the phase-109 allowlist hint.

## Work items

### R1 — Structural gemma rule

Add `"<key>:<|"|>` → `"<key>":"` to the repair pipeline, ordered ahead of the
blanket `<|"|>` → `"` rule. `<key>` is a conservative JSON-key charset (e.g.
`[A-Za-z_][A-Za-z0-9_]*`), not `.*`. Driven by the real phase-113 fixture:
after repair, the previously-dead logstats response must parse and yield its
files.

### R2 — Array-boundary rules

Two narrow rules covering all three observed gpt-oss corruptions:

- `},"{"` → `},{"` (stray quote)
- `},"<key>":` → `},{"<key>":` (missing `{`), same conservative key charset

These are riskier than R1 — `},"<key>":` could in principle occur inside a
legitimate *string value*. Apply structural rules only in the repair path
(after a parse failure), never to text that already parses, and add a test
proving a valid envelope containing `},"path":` inside a string value
round-trips untouched. If a repaired candidate still fails to parse, fall
through to the existing braceWalk retry unchanged.

### R3 — Repair forensics

`repairJsonText` (or its caller) reports which rules fired and how many
times. Thread `{ruleId, count}` into `_extractionMeta.repairs` alongside the
existing candidateCount/proposalCount/merged so forensics can see artifact
density per response. (Threading meta into summary.json/`kodr why` remains a
separate NEXT.md item; this phase only enriches the meta object.)

### R4 — Unknown-tool steering

When the model calls a tool that is not in the registry, the tool-result
feedback currently says it failed but does not redirect. Make the error
message name the valid tools and restate the contract: there is no write
tool — file changes go in the files/patches arrays of the final JSON
envelope. Mirror the phase-109 allowlist-hint pattern and wording style.
Evidence: gpt-oss `write_file` in all three runs above.

### R5 — Fixtures from real responses

Extract minimized excerpts from the saved raw responses into test fixtures
(cite provenance paths in a comment). Plus an offline replay test: the three
full gpt-oss final-turn contents and the gemma logstats content, fed through
`extractProposal`, must now produce valid proposals with the expected file
paths. This is the strongest validation the phase has — it replays the exact
bytes that failed in production.

## Testing

- Unit tests per rule: fires on the fixture excerpt, does not fire on valid
  JSON, does not corrupt legitimate string values containing the pattern.
- Rule-ordering test: structural rules run before the blanket rule.
- Offline replay tests (R5) on the four real saved responses.
- `_extractionMeta.repairs` populated when rules fire, absent/empty when not.
- Unknown-tool feedback test: registry rejects `write_file`, response text
  names valid tools and the envelope contract.
- Full suite, `npm run format`, `npm run check` green.

## Done criteria

- [x] R1: gemma structural rule, ordered before the blanket rule, fixture-proven.
- [x] R2: both array-boundary rules, repair-path-only, with a
      no-false-positive test on valid string values.
- [x] R3: `_extractionMeta.repairs` records fired rules.
- [x] R4: unknown-tool feedback steers to the envelope.
- [x] R5: offline replay of all four saved corrupt responses produces valid
      proposals.
- [x] `process/failures.jsonl` / `process/decisions.jsonl` updated.
- [x] Blog post `blog/115-structural-decode-artifact-rules.md`.
- [x] NEXT.md entries shipped by this phase deleted (FIFO).
- [x] Version bumped to 0.0.115; suite green; committed.
- [ ] Live validation (run after the commit, sequential): smoke + greenfield
      run on `mistralai/devstral-small-2-2512` (new model — establish its
      baseline and watch for a signature corruption of its own), then a
      greenfield re-run on `openai/gpt-oss-20b` to observe whether the
      boundary rules rescue a live run end-to-end.
