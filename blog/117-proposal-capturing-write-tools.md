# Phase 117 — Proposal-Capturing Write Tools

The mistake was visible in the Phase 115 log: gpt-oss called `write_file` five times, every argument valid, every call rejected with "unknown tool." Then it corrupted the files[] array boundary in its closing envelope. The tool-call channel was working fine. The free-text channel was broken. Kodr was only reading the broken one.

## Ten phases in the wrong channel

The arc starts at Phase 104. Kodr's proposal contract sends file content inside JSON string values embedded in free-decoded model output — the least-constrained channel on the stack. The model writes whatever bytes it wants. The harness parses what it can.

Phase 104 introduced the decode-artifact pipeline. Phase 112 added the first structural repair rule. Phases 113–114 chased gpt-oss boundary corruptions across three runs, two distinct corruption shapes, zero clean envelopes. Phase 115 wrote the repair rules that rescued those bytes.

Meanwhile the tool-call channel — grammar-constrained and server-parsed by LM Studio — carried the same models' function arguments without a single parsing failure. gpt-oss called `write_file` in every Phase 113 and 114 run. Its arguments were valid every time. The harness threw them away because no such tool was registered.

Phase 116 ran devstral. It never produced an envelope. It called a native `files` tool four or five times per run, ignored all steering, and walked away. Zero usable runs.

The signal across five phases was consistent: agentic-trained models reach for write tools. The channel they were reaching for was the constrained one. The channel Kodr was defending was the free-text one.

## The inversion

Phase 117 registers the tools they are reaching for.

`write_file {path, content}` and `edit_file {path, search, replace}` are now in the registry. Neither touches disk. Both call `jailedPath` at capture time — the same jail the apply step enforces — and return a steering error on violation. Valid calls accumulate in a `ProposalDraft`: file writes last-wins per path, patches appended in document order, mirroring the envelope's `files` and `patches` fields exactly.

When the tool loop ends and the draft is non-empty, the forced final envelope turn is skipped — captures already constitute a proposal. The model can still return a closing envelope; if it does, `mergeProposalWithDraft` applies envelope-wins-per-path semantics. Working state does not overwrite the model's final word. If it doesn't return an envelope, the captured draft is the proposal. Either way, `status` derives from the verification runner's result. Trust does not cross the model boundary in either direction.

Empty draft with no envelope is byte-identical to pre-117. Gemma and any other envelope-first model are unaffected.

## The alias map

devstral called `files`, not `write_file`. OpenHands models call `str_replace_editor`. These are trained-in names from fine-tuning data we don't control. Rejecting them as "unknown tool" and hoping the model redirects has not worked — five phases of evidence.

`DEFAULT_TOOL_ALIASES` ships with four mappings: `files → write_file`, `create_file → write_file`, `str_replace_editor → edit_file`, `apply_patch → edit_file`. Dispatch resolves aliases before the unknown-tool check. Alias hits are recorded in `ProposalDraft` and surfaced in `proposalChannels` in `summary.json`. A genuinely unknown tool name still gets the Phase 115 steering message — the positive redirect, not a flat rejection.

Argument shape mismatches on aliased calls return a steering error naming the canonical schema. devstral's `files` tool schema is unknown from the logs — it was called with empty arguments in Phase 116. The live validation will tell us what it actually sends; the response is recorded in `failures.jsonl` as an open question, not a closed defect.

## The prompt change

The tools block previously contained one line that did significant harm: "There is no write or edit tool — all file changes go in the files/patches arrays." Phase 114 established the lesson: prohibitions are worse than silence for constrained-budget prompts. Models read "no write tool" as "write tool is the thing I should try next."

That line is gone. The tools block now lists `write_file` and `edit_file` with positive descriptions. The closing text says "Use write_file or edit_file to propose file changes. You may also return a final JSON envelope — both channels work; the harness merges them." The envelope is still valid. The capture path is now also valid. The model can use either or both.

The tools block grew by two lines — roughly 220 characters — so the prompt budget guard was updated deliberately from 2900 to 3200. The guard exists to catch accidental bloat; intentional growth with a comment is the right adjustment.

## Provenance in summary.json

`proposalChannels` lands in `summary.json` on every run: `{captured: N, envelope: M, aliasHits: {...}}`. `kodr why` surfaces it in the Proposal Extraction step. "4 files via write_file, 0 via envelope" is now a data point, not an inference.

Phase 118 and 119 will use this data to decide whether to demote the envelope requirement for tool-capable profiles. This phase does not demote anything. The evidence collection happens first.

## Regression contract

Existing envelope tests pass unchanged. The `mergeProposalWithDraft` function returns the envelope unmodified when the draft is empty. The `isFinalTurn` F1 condition is gated on `!draftNonEmpty` — when the draft is empty, the forced final turn fires exactly as before. The 1095 pre-phase tests stayed green; the 23 new tests all pass.

gpt-oss writes to its envelope boundary. Gemma writes to its envelope content. Both will keep working. The question Phase 117 asks is whether gpt-oss prefers the declared tool path when one is available, and whether its envelope corruption rate drops when file content rides the constrained channel instead of the free-text one. That question has a scheduled answer: the live validation run.
