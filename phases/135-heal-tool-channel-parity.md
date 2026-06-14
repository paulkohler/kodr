# Phase 135 — Heal Tool-Channel Parity

## Motivation (a real dogfood failure)

A phase-135 dogfood ran a 3-file ESM CLI task against two loaded local models.
Devstral passed cleanly (A). **Qwen wrote correct application code but a broken
test file** (`await import('node:fs')` inside non-`async` `node:test` callbacks →
`SyntaxError`), verification failed, and healing engaged. In the heal turn qwen
**correctly diagnosed the bug** ("await used inside non-async test callbacks")
and issued real `read_file` + `edit_file` **native tool calls** to fix it
(visible in `repairs/turn-1/raw-response.json`: `finish_reason: tool_calls`,
three tool-call rounds with the right edits).

The harness threw the fix away. `healStopReason = invalid_proposal`, one turn,
broken file still on disk, `ok: false`.

**Root cause — the heal loop is stuck on the pre-117 channel.** The main
generation path was inverted in the 117–119 tool-channel arc: file content rides
the captured `proposalDraft` from `completeWithToolCalls`, and in native mode
"the draft IS the proposal" (`mergeProposalWithDraft(capturedDraft, null)` at
app.mjs ~3497). But the self-heal `repairTurn` closure (app.mjs ~4749) calls
`completeWithToolCalls` and then **forwards only `{ raw, text }`** — it drops
`completion.proposalDraft`. `runSelfHealingLoop` then does
`normalizeRepairProposal(extractJson(completion.text))`. A tool-using model
expresses its edits through tool calls and leaves the text channel ~empty (qwen:
2 chars), so extraction throws `JsonExtractionError` → `invalid_proposal` → the
loop breaks after one turn, discarding the captured edits.

So: a model that *correctly fixes the bug* is reported as a heal failure purely
because the repair turn reads the wrong channel. This is the single biggest
"reliably codes for me" gap the dogfood found, and the fix is to give the heal
loop the same two-channel handling the main path already has.

## Design principles

1. **Channel parity, not new behavior.** Healing should consume the captured
   tool-call draft exactly like the main native path: a non-empty draft is the
   proposal; otherwise fall back to the text/envelope extractor. No new
   re-prompt machinery in the loop — just stop ignoring the draft.
2. **Draft does not shadow envelope.** An *empty* draft must not suppress a
   valid envelope in `text` (mirror the main path's `draftNonEmpty` guard).
3. **Minimal surface.** The loop already applies and verifies per turn in
   `apply` mode; only proposal *acquisition* changes. `normalizeRepairProposal`
   already coerces `{files, patches, scratchpad}`, which is the shape
   `mergeProposalWithDraft` produces — so the draft proposal flows through
   unchanged.

## Work items

### A — `runSelfHealingLoop` accepts a pre-built proposal (`src/healing.mjs`)

- The `repairTurn` result may now carry an optional structured `proposal`
  (`{ files, patches, scratchpad? }`) alongside `text`/`raw`.
- In the loop, replace the unconditional
  `normalizeRepairProposal(extractJson(completion.text))` with:
  - if `turnResult.proposal` has at least one file or patch → use
    `normalizeRepairProposal(turnResult.proposal)`;
  - else → `normalizeRepairProposal(extractJson(turnResult.text || ''))`
    (unchanged behavior).
  Keep the existing `invalid_proposal` break for the case where *both* channels
  are empty (extractor throws and no draft).
- No other loop logic changes (apply, verification, no-progress, wrong-path,
  goal-substitution judge all unchanged).

### B — `repairTurn` forwards the captured draft (`src/app.mjs`, `runHealingIfNeeded`)

- After `completeWithToolCalls`, compute `capturedDraft =
  completion.proposalDraft ?? null` and `draftNonEmpty = capturedDraft &&
  !capturedDraft.isEmpty`. When non-empty, set `proposal =
  mergeProposalWithDraft(capturedDraft, null)` (same call the main native path
  uses). Return `{ proposal, raw, text }`; when the draft is empty or the
  non-tools `completeWithContinuations` branch ran, return `{ text, raw }` as
  today (envelope fallback preserved).
- `mergeProposalWithDraft` is already imported in app.mjs.

### C — Forensics (light)

- The heal-summary sites already record `healStopReason`. With this fix a
  tool-model heal that previously read `invalid_proposal` will read `healed`;
  no schema change. If a per-turn `proposalSource` (`captured`|`envelope`) is
  trivially threadable into the existing `repairs[]` turn record, add it for
  `kodr why`; otherwise skip (not required for the fix).

## Testing (`node:test`, no live model)

`test/healing.test.mjs`:

1. **Captured-draft heal (the regression this fixes).** A `repairTurn` that
   returns `{ proposal: { files: [{ path, contents }] }, text: '' }` (empty
   text, as a tool-using model produces) with a fake `commandRunner` that fails
   before the write and passes after → the loop applies the file, verification
   passes, `healed: true`, `stopReason: 'healed'`. Before the fix this path
   would throw `invalid_proposal` on the empty text.
2. **Envelope still works (regression guard).** `repairTurn` returning `{ text:
   '<valid envelope JSON>' }` and no `proposal` → heals as before.
3. **Empty draft does not shadow envelope.** `repairTurn` returning `{ proposal:
   { files: [], patches: [] }, text: '<valid envelope>' }` → the envelope is
   used (file applied), proving an empty draft falls through.
4. **Both channels empty → invalid_proposal.** `repairTurn` returning `{ text:
   '' }` (no proposal) → `stopReason: 'invalid_proposal'` (unchanged).

`npm run format`, full `npm test` green (report counts), `npm run check`.

## Live validation (kodr-test-operator, separate)

Re-run the exact phase-135 qwen task (`~/src/kodr-testing/phase-135/tasks-qwen`
shape) against `qwen/qwen3.6-35b-a3b`. Expect: the same broken-test-file first
draft, but now the heal turn's captured `edit_file` calls are applied, `node
--test` passes, `healed: true`, the file on disk is fixed. Confirm devstral (the
A-grade path) is unregressed.

## Done criteria

- [x] A: `runSelfHealingLoop` prefers a pre-built `proposal` from the turn
      result, falls back to the text extractor, keeps `invalid_proposal` only
      when both channels are empty.
- [x] B: `runHealingIfNeeded` `repairTurn` forwards the captured
      `proposalDraft` via `mergeProposalWithDraft` for tool-mode turns.
- [x] C: forensics unchanged/augmented (optional `proposalSource`).
- [x] Tests (captured-draft heal, envelope regression, empty-draft-no-shadow,
      both-empty invalid). Full suite + format + check green.
- [x] `process/failures.jsonl`: record the dogfood failure AND the operator's
      mis-attribution (it reported a turn-budget/partial-edit-discard cause; the
      artifacts showed one turn and a channel mismatch — verify root cause
      against artifacts, not the operator's narrative).
- [x] `process/decisions.jsonl`: heal consumes the captured tool draft (channel
      parity with the 117–119 main path).
- [x] Blog post `blog/135-heal-tool-channel-parity.md`.
- [x] NEXT.md updated; version bumped to 0.0.135; roadmap line checked;
      committed.
