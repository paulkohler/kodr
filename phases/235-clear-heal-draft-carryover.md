# Phase 235 — Clear the Proposal Draft Before Each Heal Turn (Stale Carryover Fix)

## Motivation (the heal that re-wrote what was already there)

In a non-staged `kodr run` with tools on, the model's `write_file` / `edit_file`
calls are captured into the shared `registry.proposalDraft`. The main pipeline
builds its proposal from that draft and applies the writes — but **never clears
the draft afterward**. The SAME `registry` is then handed to the heal loop. So on
a heal turn, `completion.proposalDraft` STILL holds the main run's already-written
files, and the heal `repairTurn` callback re-emits them as a non-empty proposal of
**no-op writes** (the proposed content is byte-identical to disk).

Two harms:

1. **Spurious no-op heal writes.** The heal turn applies the main run's files again
   — empty diffs, real backups taken, snapshot unchanged. Noise and wasted
   apply+backup work on every heal turn.
2. **Phase-231 runaway classification is defeated.** Because the forwarded heal
   proposal is non-empty, `isReasoningRunaway`'s first guard (`if (proposalNonEmpty)
   return false`, `src/healing.mjs:154`) suppresses the `reasoning_runaway` label.
   A genuine reasoning runaway (model read files, then ran chain-of-thought to
   `finish_reason: length` with zero answer tokens, never calling `write_file`) is
   mislabeled `no-progress-exhausted`. Phase 231's accurate classification is
   defeated whenever the main run wrote files — the common case.

## Live evidence (phase-234 dogfood `phase-234/cap-wiring-1`, recorded in `process/failures.jsonl` under phase 234)

The model created 3 files in the main run (`src/counter.js`, `src/cli.js`,
`test/counter.test.js`). Tests failed; heal engaged. Heal turn-1
`raw-response.json`: `finishReasons: ['tool_calls','length']`,
`loopBudget.stopReason: 'finish_length'` — sub-turn 0 = `read_file` ×2 (the model
only READ), sub-turn 1 = pure reasoning to `finish_reason: length`, 0 content, NO
`write_file` ever called. Yet `repairs/turn-1/writes.json` shows a proposal of
**exactly those same 3 files** applied as no-ops:

```json
{ "path": "src/counter.js", "status": "modify",
  "diff": "--- src/counter.js\n+++ src/counter.js\n",
  "hash": "97b6dc73…" }   // empty diff, REAL content hash
```

The **empty diff with a real (non-null) content hash** is the tell: the proposed
content is byte-identical to what is already on disk — i.e. the main run's
already-written *full-content* files, re-emitted. (This corrects the phase-234
failures-entry framing of "3 EMPTY-content files / contentLen:0": the *diff* is
empty, the *captured content* is not. The carryover is full-content, not stubs —
so the candidate's "diagnose where the empty stubs originate / repair-context
failurePaths" hypothesis is the wrong lead.) Because the proposal was non-empty,
the phase-231 runaway label was suppressed and the turn fell through to
`no-progress-exhausted`.

## Root cause

The main non-staged path (`src/run-pipeline.mjs` ~974-988 and the W3/W4 merge
~1080-1088) builds the proposal via `mergeProposalWithDraft(capturedDraft, …)` and
applies the writes, but **never clears `proposalDraft`**. Only the STAGED path
clears it — `registry?.proposalDraft?.clearFiles(appliedPaths)` at
`run-pipeline.mjs:2195`. The same `registry` is then passed into
`runHealingIfNeeded` (call sites `run-pipeline.mjs:1567` main heal AND
`run-pipeline.mjs:1615` smoke heal) → the shared `repairTurn` callback
(`run-pipeline.mjs:2590-2627`) → `completeWithToolCalls(repairOptions, model,
prompt, systemPrompt, registry)`. The callback computes `capturedDraft =
completion.proposalDraft` (= `registry.proposalDraft`, the SAME instance —
`tool-calls.mjs:339` reads `registry?.proposalDraft`), finds `draftNonEmpty`
**true (stale)**, and returns `proposal: mergeProposalWithDraft(capturedDraft,
null)` — re-emitting the stale files.

Nothing clears the draft between the main apply and the heal loop, **nor between
heal turns**: `healing.mjs` applies heal writes via `prepareChanges(cwd, proposal,
{apply})` (~line 422) and never touches the registry draft, so a turn-2 would also
inherit turn-1's (and the main run's) writes.

## Trace confirmation (verified by reading)

- Registry created once at `run-pipeline.mjs:441` (`createBuiltinRegistry`, which
  builds one `new ProposalDraft()` at `tool-calls.mjs:690`).
- That registry flows into the main completion call (~577), into both
  `runHealingIfNeeded` call sites (1567, 1615), and into the `repairTurn` closure
  (2598).
- `completion.proposalDraft` is `registry.proposalDraft` (`tool-calls.mjs:339`),
  so the heal callback sees the **same mutable draft** the main loop populated.
- The main path **reads** `capturedDraft` AFTER apply — `capturedDraft?.aliasHits`
  (1172), `capturedDraft?.files.length`/`patches.length` for `proposalChannels`
  W5 forensics (1176), and `buildLiveWriteRecords(capturedDraft)` (1357). All of
  these run during the proposal/apply block, **before** the heal call at 1567. So
  by the time heal runs, the main run is completely done consuming the draft.

## ProposalDraft API (verified — `src/tool-calls.mjs:84-178`)

`ProposalDraft` exposes `recordFile`/`recordPatch`/`recordAlias`, getters
`files`/`patches`/`aliasHits`/`isEmpty`, `getCapturedContent(path)`, and
`clearFiles(paths)`. **There is no full reset method, and `clearFiles` deletes
only `_files` — it does NOT clear `_patches` or `_aliasHits`.** A stale heal turn
can carry stale *patches* too (a main run that used `edit_file`), so
`clearFiles(files.map(f=>f.path))` would be an incomplete reset. The fix therefore
adds a small `clear()` method that empties all three accumulators.

## The fix

### 1. Add a full `clear()` to `ProposalDraft` (`src/tool-calls.mjs`, after `clearFiles` ~line 177)

```js
// Phase 235: full reset of the shared draft. clearFiles() removes only file
// entries; clear() also drops captured patches and alias hits, so a reused
// registry (e.g. across the main run -> heal loop) starts each heal turn with a
// clean capture surface and never re-emits a prior turn's writes.
clear() {
	this._files.clear();
	this._patches.length = 0;
	this._aliasHits.clear();
}
```

`isEmpty` (checks `_files.size === 0 && _patches.length === 0`) returns `true`
immediately after `clear()`, which is exactly the signal the heal/main draft
guards key on.

### 2. Reset the draft at the START of each heal turn (`src/run-pipeline.mjs`, top of the `repairTurn` callback ~2590)

Before the `completeWithToolCalls` call, when `options.tools && registry`, clear
the shared draft so the turn captures ONLY its own writes:

```js
repairTurn: async ({ prompt }) => {
	// Phase 235: the shared registry.proposalDraft is reused from the main run
	// (and across heal turns). The main pipeline never clears it after apply (only
	// the staged path does, at clearFiles ~2195), so without this reset the heal
	// turn re-emits the main run's already-written files as no-op writes — and that
	// non-empty proposal defeats phase-231's runaway classification (the
	// proposalNonEmpty guard in isReasoningRunaway). Clear at turn-start so each
	// turn captures only its own write_file/edit_file calls; the main run is fully
	// done consuming the draft by the time heal runs (its forensics reads at ~1172/
	// 1176/1357 all precede the heal call at 1567).
	if (options.tools && registry) {
		registry.proposalDraft?.clear();
	}
	const completion =
		options.tools && registry
			? await completeWithToolCalls(
					repairOptions,
					model,
					prompt,
					systemPrompt,
					registry,
				)
			: await completeWithContinuations(
					repairOptions,
					model,
					prompt,
					systemPrompt,
				);
	// …unchanged: raw, the options.tools && registry draftNonEmpty merge, return…
};
```

The rest of the callback (the `raw` object, the `if (options.tools && registry)
{ capturedDraft … draftNonEmpty … mergeProposalWithDraft(capturedDraft, null) }`
merge, the `{ raw, text }` fallback) is **byte-identical** — `clear()` only changes
what the draft holds when that merge runs, not the merge logic.

### Why clear at turn-start (and why not the alternatives)

- **Safe.** The main run has finished consuming the draft well before the heal call
  (forensics reads at 1172/1176/1357 are inside the main proposal/apply block; the
  heal call is at 1567). Clearing here cannot perturb any main-run artifact.
- **Covers both carryover modes in one place.** Turn-1 carryover (main run → heal)
  and turn-2+ carryover (heal turn N → heal turn N+1) are both fixed, because every
  heal turn resets before its own model call.
- **The turn's own writes survive.** `clear()` runs BEFORE `completeWithToolCalls`,
  so any `write_file`/`edit_file` the model issues *during* this heal turn is
  captured fresh into the now-empty draft and survives into the merge. A legitimate
  heal write is preserved.
- **Rejected: clear once before the heal loop.** Would fix turn-1 carryover but not
  inter-heal-turn carryover (turn-2 would still inherit turn-1's writes). Turn-start
  clearing is strictly more correct for the same cost.
- **Rejected: clear in the main path after apply.** Broader blast radius — the main
  path reads the draft after apply (`aliasHits` 1172, `proposalChannels` 1176,
  `buildLiveWriteRecords` 1357). Clearing there would zero out live-write records
  and W5 forensics. The heal callback is the correct, narrow seam.

## Edge cases & decisions

- **Staged path untouched.** `runStagedPrompt`'s `clearFiles(appliedPaths)` at 2195
  is not modified; staged runs never enter `runHealingIfNeeded`'s tool-call heal
  channel via this callback path the same way, and the new `clear()` is a separate
  method. Staged behavior is byte-identical.
- **Legitimate heal write preserved.** Clear happens BEFORE the model call; the
  turn's own `write_file` lands in the fresh draft → `draftNonEmpty` true → merged
  and applied. (Test (c).)
- **Tools OFF heal.** When `!(options.tools && registry)` the callback uses
  `completeWithContinuations` (text channel) and there is no registry draft to
  clear — the `if (options.tools && registry)` guard skips the `clear()` cleanly.
  Unaffected.
- **Capture semantics intact.** `completeWithToolCalls` reads
  `registry.proposalDraft` at `tool-calls.mjs:339` at call time and records into it
  as tool calls arrive; clearing the SAME instance immediately before the call
  leaves a valid empty draft to capture into. No re-wiring of the registry.
- **Main-run proposal / apply / forensics byte-identical.** We only `clear()`
  inside the heal callback, which runs strictly after the main run's draft reads.
- **`clear()` vs `clearFiles`.** `clearFiles` is retained unchanged (staged path
  depends on its file-only semantics). `clear()` is the new full reset; it also
  drops stale patches/aliasHits so an `edit_file`-heavy main run cannot leak stale
  patches into a heal turn.

## Tests

### `test/healing.test.mjs` — unit test on `ProposalDraft.clear()`

- [x] `clear()` empties files, patches, AND alias hits; `isEmpty` is `true`
  afterward. (Import `ProposalDraft` from `../src/tool-calls.mjs`; `recordFile`,
  `recordPatch`, `recordAlias`, then `clear()`, then assert
  `files.length === 0`, `patches.length === 0`, `aliasHits` is `{}`, `isEmpty`.)
- [x] `clearFiles` regression: still removes only files, leaves patches (guards the
  staged invariant that `clear()` does not subsume).

### `test/app.test.mjs` — end-to-end via `startFakeModelServer` (the dogfood reproduction)

Model the existing native-heal harness at `test/app.test.mjs:3213` (`run --yes
--test … --heal`, queued `responses`, `tool_calls` turns supported by
`test-support/fake-model-server.mjs:150-161`). The main run writes a file via a
`write_file` tool-call turn; the test command fails; heal engages with a stale main
draft. Assert against `repairs/turn-1/` artifacts.

- [x] **(a) THE BUG** — main run writes file A (applied); the heal turn is
  read-only / runs away (no `write_file`). Assert the heal proposal / `writes.json`
  does **NOT** re-emit A (no stale no-op write). Pre-fix this FAILS (A re-emitted as
  a no-op `modify` with an empty diff).
- [x] **(b) Restored phase-231 accuracy** — heal turn with `finish_reason: length`
  + empty text + a (pre-populated) main draft now classifies `reasoning_runaway`
  (writes `repairs/turn-1/runaway.json`, `repairs.stopReason === 'reasoning_runaway'`),
  NOT `no-progress-exhausted`. Pre-fix: `no-progress-exhausted`, no `runaway.json`.
- [x] **(c) Legitimate heal write preserved** — heal turn that DOES `write_file` a
  real fix → that write is in `writes.json` and applied (file on disk updated, heal
  passes). Proves clearing-before-the-call does not eat the turn's own write.
- [x] **(d) Inter-turn carryover** — turn-1 writes file B (applied, but test still
  fails), turn-2 writes nothing → turn-2 proposal does not re-emit B. (If the
  fake-server harness cannot cleanly stage a two-heal-turn sequence, cover (d) at
  the unit level instead and note in the test file that turn-start clearing makes
  (a) and (d) the same mechanism.)
- [x] Confirm existing heal tests pass unchanged: `test/app.test.mjs:3213`
  ("can heal a failed verification…"), the auto-heal / `--no-heal` tests (~3297,
  ~3350), and the phase 135/215/224/225/233 staged+heal tests in
  `test/app.test.mjs`. Confirm `test/healing.test.mjs` `isReasoningRunaway` /
  `runSelfHealingLoop` injected-`repairTurn` tests pass unchanged (they inject a
  `repairTurn` directly and never touch a registry draft, so they are unaffected).

## Work items (Required Loop)

- [x] Add `ProposalDraft.clear()` to `src/tool-calls.mjs` (after `clearFiles`).
- [x] Add `registry.proposalDraft?.clear()` at the top of the `repairTurn` callback
  in `src/run-pipeline.mjs` (~2590), gated on `options.tools && registry`. The rest
  of the callback unchanged.
- [x] Unit test on `clear()` in `test/healing.test.mjs`; end-to-end (a)-(d) heal
  tests in `test/app.test.mjs`. Confirm the existing heal + staged+heal tests pass
  unchanged.
- [x] `npm run format` (globally-installed Biome; do not add it as a dependency).
- [x] Run tests (`node --test` / `npm test`).
- [x] `npm run check` — requires `package.json` version == max roadmap phase, so
  bump `0.0.234` → `0.0.235` first.
- [x] `process/decisions.jsonl`: record the stale-draft-carryover fix — clear the
  shared `registry.proposalDraft` at heal-turn-start via a new `ProposalDraft.clear()`
  (full reset of files + patches + aliasHits, since `clearFiles` clears only files);
  why turn-start (covers main→heal AND inter-heal-turn carryover; the turn's own
  writes survive because clear precedes the model call); why NOT the main path
  (post-apply forensics reads at 1172/1176/1357). Cite the phase-234 dogfood
  evidence (`phase-234/cap-wiring-1` turn-1: 3 files re-emitted as empty-diff /
  real-hash no-ops; correct the "empty-content" framing to "stale full-content
  no-op carryover") and state this **restores phase-231 runaway classification**
  (the non-empty stale proposal was tripping the `proposalNonEmpty` guard in
  `isReasoningRunaway`).
- [x] `process/failures.jsonl`: the underlying finding is already recorded under
  phase 234 (the `phase":234` entry: "agentic heal channel fabricates a proposal of
  empty-content file entries … masks a genuine reasoning runaway as no-progress").
  Add a SHORT phase-235 entry that (i) marks it FIXED, (ii) **corrects the root
  cause** — not fabricated empty-content stubs but stale full-content draft
  carryover from the main run (proven by the empty-diff + real-content-hash in
  `writes.json`), so the phase-234 entry's "diagnose where the 3 empty-content
  entries originate / repair-context failurePaths" hypothesis was the wrong lead —
  and (iii) names the fix (`ProposalDraft.clear()` at heal-turn-start). Cross-ref
  the phase-234 entry; do not duplicate its full symptom text.
- [x] `blog/235-clear-heal-draft-carryover.md`: theme "The heal that re-wrote what
  was already there" — the empty-diff/real-hash tell, why a non-empty stale proposal
  silently defeats phase-231's runaway label, and why turn-start clearing (not main-
  path clearing) is the safe seam.
- [x] `roadmap.md`: append `- [x] 235 Clear the Proposal Draft Before Each Heal
  Turn (Stale Carryover Fix)`.
- [x] `package.json`: bump `0.0.234` → `0.0.235`.
- [x] `NEXT.md`: **remove** the "Heal channel fabricates empty-content file
  proposals (masks runaway as no-progress)" candidate (lines ~103-122) — it ships as
  this phase. (If referenced anywhere, correct its framing from "empty-content
  fabrication" to "stale full-content no-op carryover".) Update "Current frontier"
  to phase 235 (note phase 235 cleared the heal-loop draft-carryover bug so phase-231
  runaway classification is no longer defeated by main-run writes).
- [x] Commit (small, single phase).

## Must NOT change (regression guard)

- The staged `clearFiles(appliedPaths)` at `run-pipeline.mjs:2195` and `clearFiles`
  itself — file-only semantics retained for the staged path.
- The main non-staged proposal build / apply / forensics (`aliasHits` 1172,
  `proposalChannels` 1176, `buildLiveWriteRecords` 1357) — byte-identical; we clear
  only inside the heal callback, which runs strictly after these reads.
- The `repairTurn` callback's `raw` object, the `draftNonEmpty` merge, and the
  `{ raw, text }` fallback — unchanged; only a `clear()` is added before the model
  call.
- `isReasoningRunaway` (`healing.mjs:153-161`) — unchanged; this phase stops feeding
  it a stale non-empty proposal so its existing `proposalNonEmpty` guard no longer
  fires spuriously.
- Tools-OFF heal (`completeWithContinuations` channel) — the `options.tools &&
  registry` guard skips the `clear()`; behavior identical.
- `test/healing.test.mjs` injected-`repairTurn` tests — they never wire a registry
  draft, so they are untouched.
