# Phase 119 — Envelope Demotion (Adopt The Two-Channel Model)

This is the final phase of the tool-channel arc. Phase 117 added proposal-capturing write tools. Phase 118 measured tool support per (model, server, template) triple and wired the measurement into per-profile channel selection. Phase 119 completes the migration: for profiles measured as `native`, the system prompt now drops the envelope JSON contract entirely. The arc's thesis — that file content had been riding the wrong channel — is now testable in its full form.

## The confound the arc hadn't noticed

Phase 118 classified all three primaries as `native` from the probe. But the validation runs showed qwen ignoring the tool channel on a real task — no `write_file` calls, a single-turn 8,720-character envelope dump, rescued only by the T5 duplicate-key-cluster split rule added in 118.

The 118 write-up read this as a capability-vs-preference gap: qwen knows how to use tools but chose not to. The actual artifacts told a different story. Looking at `raw-request.json` from the failing run, the system prompt opened with `renderKodrBaseContract` — which starts with the full envelope JSON schema. The word `files` appeared nine times in the leading contract. The word `patches` five times. And then, buried later in the prompt, the `renderToolsBlock` — reworded in 118 for native mode to make tools primary.

Gemma received the byte-identical prompt and resolved the contradiction toward the tools. gpt-oss likewise. Qwen, the stricter instruction-follower, obeyed the leading contract.

The envelope schema paragraph was dominant. The tools-primary wording was subordinate. **Phase 118's toolWritesMode:native only reworded the buried tools block — it never touched the dominant leading envelope contract in `renderKodrBaseContract`.** The experiment of removing the envelope contract had never actually been run.

That is what phase 119 runs.

## D1: mode-aware base contract

`renderEditFormatContract` and `renderKodrBaseContract` both become `toolWritesMode`-aware. For native mode, the function returns two sentences in place of the full envelope schema:

> All file changes must go through the write_file or edit_file tools. When you have finished making all changes, reply with a short plain-text summary of what changed and why. Do not emit a JSON envelope.

No `status`, `files`, `patches`, or `scratchpad` key names. No JSON schema example. The tools block — already primary in 118 — is no longer competing with a leading schema.

For envelope and unresolved auto: byte-identical to phase 118. The coupling test (`context-packer.test.mjs`) asserts that `renderKodrBaseContract` and `renderEditFormatContract` return identical text per mode, so neither can drift alone.

## D2: the native final turn

In native mode, a non-empty `ProposalDraft` IS the proposal. The forced-final-envelope turn (the F1 condition in the tool loop) is already skipped when the draft is non-empty (phase 117's W3 rule). Native mode goes further: no JSON parse is attempted on the trailing assistant text. The closing assistant turn becomes the run message — a short prose summary of what changed. `status` is whatever verification returns; the model's text never sets it.

No `ProposalMissingError` is possible when the draft is non-empty. The model wrote files through tools; the harness knows. There is nothing to assert missing.

## D3: the empty-draft safety net

This is the heart of the phase. Phase 118's confound evidence demanded a specific failure to handle: native mode, model finishes with no tool calls and no parseable envelope. This happens when a model obeyed the subordinate tools-primary wording in 118 but will now face a prompt with the envelope contract genuinely absent. We must not assume it will adopt the tools — we must handle both outcomes.

Three branches in order:

**1. Envelope fallback.** If the model's text contains parseable envelope JSON despite native mode — which is likely for qwen on any given run — parse it with the existing extractor, including all eleven phases of decode-artifact and structural repair rules. Record `recoveredVia: 'envelope-fallback'`. This is a free recovery: the extractor is already loaded, T5 and every other repair rule are still active. The model got the wrong channel; the harness reads it anyway.

**2. Single envelope re-prompt.** If even the extractor can't find a parseable proposal, issue one follow-up message that re-introduces the full envelope contract for this turn only: "You did not use the write_file or edit_file tools. Return your changes as this JSON envelope: …" Exactly one. Never a loop — the phase-113 single-retry discipline applies here too. Record `recoveredVia: 'envelope-reprompt'`.

**3. Distinct error.** If the re-prompt also yields nothing: `NativeNoProposalError`. A distinct error class — not `ProposalMissingError` — that names what happened: "native-mode model produced no tool writes and no envelope after one re-prompt." Propagates through `main` as a `CliError` with the same message. Never a silent empty proposal.

D3 is what makes envelope demotion safe to deploy before live validation. Worst case degrades to exactly the phase-118 behaviour: envelope extraction plus T5. Best case the model adopts the tools and D3 never fires. Either is a valid run.

## D4: the prompt-budget win

The envelope schema paragraph is ~600 characters. Native mode's two-sentence replacement is ~200 characters. The D4 test asserts the native-mode system prompt is at least 400 characters shorter than envelope mode — a concrete, measurable payoff of the arc.

That budget doesn't just save bytes. It removes the instructions the models keep obeying at the expense of the new ones. Shorter and less contradictory is strictly better.

## D5: forensics fields

`summary.json` gains three fields for native-mode runs: `toolWritesMode` (resolved value — `'native'`, `'envelope'`, or `'auto'`), `recoveredVia` (`'none'` when the draft path was taken, `'envelope-fallback'` or `'envelope-reprompt'` when D3 fired), and `proposalChannels` (existing `{captured, envelope, aliasHits}` — now consistently present for all modes).

`kodr why` surfaces these in the Proposal Extraction step. "native mode: 2 files via write tools, no fallback needed" is a different story than "native mode: 0 tool writes, recovered via envelope fallback (T5 split applied)." Both are informative; the first is the goal.

## What the live validation will tell us

qwen running against this prompt for the first time with the envelope schema genuinely absent. The D3 safety net means every outcome is informative and none strands the run:

- qwen uses `write_file`/`edit_file`: `recoveredVia: 'none'`, proposal from draft. The arc's thesis is confirmed for qwen's triple.
- qwen emits envelope JSON anyway: `recoveredVia: 'envelope-fallback'`. Consistent with the phase-118 runs; qwen has a strong prior and needs more signal.
- qwen emits unstructured prose: one re-prompt fires, `recoveredVia: 'envelope-reprompt'`. The re-prompt is the same contract as 118; if the model responds to it, recovery is clean.
- qwen's re-prompt also yields nothing: `NativeNoProposalError`. Diagnostic, not silent.

gpt-oss and gemma: confirm no regression from the path that's been working since 117. The live validation is the decisive experiment the arc has been pointing at.

## Test coverage

1,153 tests pass. New tests added this phase:

- **D1 (edit-formats.test.mjs):** native contract has no schema key names, contains the two tool-first sentences, is shorter than envelope mode. Envelope/auto byte-identity regression.
- **D1 (context-packer.test.mjs):** per-mode coupling test asserting `renderKodrBaseContract` output matches `renderEditFormatContract` per mode. D4 length assertion: native ≥ 400 chars shorter than envelope.
- **D2 (app.test.mjs):** fake server returning write-file tool calls + stop turn → `proposalFound: true`, `recoveredVia: 'none'`, `proposalChannels.captured > 0`. Also with `--yes` flag.
- **D3 branch 1 (app.test.mjs):** empty draft + envelope-shaped JSON in model text → `recoveredVia: 'envelope-fallback'`.
- **D3 branch 2 (app.test.mjs):** empty draft + prose → one re-prompt fires → `recoveredVia: 'envelope-reprompt'`. Asserts re-prompt fires at most once (2 total server requests).
- **D3 branch 3 (app.test.mjs):** empty draft + prose re-prompt also prose → `CliError` wrapping `NativeNoProposalError`.
- **D5 (app.test.mjs):** summary fields present; `kodr why` strings for both native paths.

## A bug this phase surfaced

The D2/D3/D5 tests write a `.kodr/model-profiles.json` to a test workspace directory and call `main(argv, {cwd: workspace})`. But `parseArgs` was calling `applyModelProfileDefaults(options, env)` without forwarding `cwd`, so the profile resolver used `process.cwd()` (the kodr project root) and never found the test profile.

`applyModelProfileDefaults` already accepted `cwd` as its third parameter — the bug was purely a missing argument in the caller. One-line fix at the `parseArgs` level, same fix applied to the agent-model loop. The fix also makes production behaviour correct: running `kodr` from a project directory will now load that project's `.kodr/model-profiles.json` even when `io.cwd` differs from `process.cwd()`.
