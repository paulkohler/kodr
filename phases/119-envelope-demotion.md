# Phase 119 — Envelope Demotion (Adopt The Two-Channel Model)

Final phase of the tool-channel arc (117 capture tools; 118 probe + channel
profiles; this phase completes the migration to a two-channel model for
native-tool profiles, with the envelope retained as the fallback).

## Framing: this is a migration to two channels, not a deletion

The real name for this phase is *adopt the architecture a native-tool harness
(e.g. Claude Code) uses*, scoped to the profiles 118 measured as capable of
it. That architecture has **two channels per turn and computes status from
neither**:

- **Tool calls** — structured, schema-constrained, server-parsed. The
  *actions*: reads, and (in Kodr) `write_file`/`edit_file` capture calls.
  File content rides here — the most-constrained channel.
- **Assistant text** — free-form prose (the markdown a user reads). The
  *narration*: what changed and why. Never parsed for control flow.
- **Status** is *computed by the harness* from tool results + the
  verification runner — declared by neither channel. The model never reports
  success; the harness observes it. (This is the 117 rule, now load-bearing:
  demotion removes the model's last self-report field, which is the point —
  it is what structurally kills the goal-substitution failure class.)

Kodr's original envelope conflated all three onto one free-text JSON object:
actions as JSON string values (least-constrained channel for the content that
needs the most constraint), narration in `messages[]`, and a self-declared
`status`. Each was on the wrong channel. The arc has been migrating each to
the right one: 117 moved actions to tools and status to verification; this
phase moves narration to plain text and removes the envelope as the primary
contract.

**The envelope was not wrong — it was the wrong default.** A single JSON
object over plain text is the correct lowest-common-denominator surface for a
(model, server, template) triple with *no* native tool support — a real,
measurable condition (118's `fallback`/`none` classifications). The mistake
was making the fallback the only path. The end state is therefore strictly
more general than a Claude-style harness: native triples get the two-channel
loop; no-tool triples get the envelope; the probe *measures* which per triple
instead of assuming. Kodr can assume nothing about an arbitrary local model
on an arbitrary server, so it adapts — that generality is the deliverable, not
a compromise.

There is also a workflow argument, not just a parsing one: the envelope forces
the model to emit the whole solution in one blind generation with no feedback
(exactly why qwen one-shot-dumped 8 KB and got the word-count logic subtly
wrong). The tool loop is a better cognitive shape — write, run, observe,
correct — so the migration buys grounded iteration as well as a constrained
channel. (Full reasoning: `blog/two-channel-realization.md`.)

One thing deliberately NOT copied from Claude Code: its edit tool writes to
disk immediately. Kodr keeps capture-into-a-proposal + dry-run review (117) —
the tool result says "recorded, applies after verification," not "written."
The two-channel model does not require eager disk writes; the safety property
stays.

## Motivation, sharpened by a phase-118 investigation

Phase 118 measured all three models as tool-`native` but observed qwen still
emitting the envelope on a real task, and we provisionally read that as a
capability-vs-preference gap. Investigating the actual artifacts changed the
diagnosis:

- qwen's greenfield run did the whole task in **one turn, zero tool calls**,
  dumping an 8,720-char envelope (which then collapsed with duplicate keys
  and was rescued by the 118 T5 rule).
- The system prompt it received **opens with the full envelope JSON schema**
  (`renderKodrBaseContract` → identity line + `{"status","files","patches",
  "scratchpad"}` + "use files for full-file writes"). "files" appears 9×,
  "patches" 5× — before the `# Tools` block's tools-primary wording.
- **gemma received the byte-identical contradictory prompt** and resolved it
  toward the tools (8 tool-call turns, `captured: 2`). gpt-oss likewise.

So qwen's "preference" is largely an artifact of a **self-contradictory
prompt**: phase 118's `toolWritesMode: native` only rewords the buried
`renderToolsBlock`; it never touches the dominant leading envelope contract
in `renderKodrBaseContract`. The models that adopt tools are overriding the
leading instruction; qwen, the stricter instruction-follower, obeys it.

Consequence: **the experiment of removing the envelope contract has never
actually been run.** We must not pre-conclude qwen will or won't adopt — but
we must build the demotion so that a model which produces neither tool
captures nor a parseable proposal degrades safely instead of failing blind.
That safety net is the heart of this phase, not an afterthought.

Evidence: `~/src/kodr-testing/phase-118/greenfield-wordfreq-qwen/.kodr/runs/2026-06-13T01-53-42.397Z/`
(qwen one-turn envelope, raw-request.json shows the leading schema);
`~/src/kodr-testing/phase-118/greenfield-wordfreq-gemma/...` (same prompt,
tool adoption); `process/failures.jsonl` phase 117/118-validation;
`src/context-packer.mjs:511` (`renderStableSection` threads toolWritesMode to
`renderToolsBlock` only); `src/edit-formats.mjs:31` (`renderEditFormatContract`,
the leading envelope text, byte-coupled to `renderKodrBaseContract`).

## Design principles

1. **Demote, don't delete.** The envelope contract, extractor, and all repair
   rules stay fully alive for `envelope`-mode profiles. Native mode gets a
   different leading contract; nothing is removed from the codebase.
2. **Scope by resolved mode only.** Only a profile whose `toolWrites`
   resolves to `native` (118's resolution: explicit `native`, or `auto` +
   a probe.json `native` classification) gets the demoted prompt. `auto`
   without a measurement and `envelope` are byte-identical to phase 118.
3. **Status from verification, always** (the 117 rule) — demotion removes the
   model's last self-report channel, so this must already be airtight.
4. **A native run can always still finish.** If the model emits no tool
   captures and no parseable proposal, the harness recovers deterministically
   (W4) rather than producing an empty proposal or a blind failure.

## Work items

### D1 — Mode-aware base contract

`renderEditFormatContract` / `renderKodrBaseContract` become
`toolWritesMode`-aware. For `native`:

- Identity line unchanged (`You are Kodr… untrusted input.`).
- **Replace** the envelope JSON schema paragraph with a tool-first contract:
  all file changes go through `write_file` / `edit_file`; when finished,
  reply with a short plain-text summary of what changed and why; do not emit
  a JSON envelope. No `files`/`patches`/`status` schema text.
- `editFormat` (whole/patch/blocks) is moot in native mode (writes go through
  tools) — native mode ignores it for the contract, but keep the function
  signature stable.

For `envelope` and unresolved `auto`: byte-identical to phase 118. The
byte-identity coupling between `renderEditFormatContract` (edit-formats.mjs)
and `renderKodrBaseContract` (context-packer.mjs) is preserved *per mode* —
update both together, extend the coupling test to assert it for each mode.

Thread `toolWritesMode` from `renderStableSection` into
`renderKodrBaseContract` (currently it only reaches `renderToolsBlock`).
Prompt-prefix stability: the prefix is still byte-stable **within a session**
(mode is fixed at session start); add native-mode fixtures deliberately
rather than letting existing fixtures drift.

### D2 — Native-mode final turn and status

- The forced-final-envelope turn (F1, tool-calls.mjs) is already skipped when
  the ProposalDraft is non-empty (117 W3). In native mode, also skip the
  envelope-extraction expectation entirely: the run's proposal IS the draft.
- A trailing plain-text assistant message becomes the run `message` (no JSON
  parse attempted in native mode). No envelope → no `ProposalMissingError`
  when the draft is non-empty.
- `status` is whatever verification returns; the model's text never sets it.

### D3 — Empty-draft safety net (the confound insurance)

The case the phase-118 evidence demands we handle: native mode, model
finishes with an **empty ProposalDraft** (no `write_file`/`edit_file` calls)
and no parseable envelope (because we removed the contract). Deterministic
recovery, in order:

1. If the model emitted envelope-shaped JSON anyway (qwen's likely
   behaviour), parse it with the existing extractor as a fallback and record
   `recoveredVia: 'envelope-fallback'`. The extractor and 115/118 repair
   rules are still loaded — this is why we demote rather than delete.
2. If there is no parseable proposal at all, issue **one** re-prompt that
   re-introduces the envelope contract for this turn only ("You did not use
   the write tools; return your changes as this JSON envelope: …"),
   `recoveredVia: 'envelope-reprompt'`. Exactly one, never a loop (mirrors
   the 113 single-retry discipline).
3. If that also yields nothing, fail with a **distinct** error
   (`NativeNoProposalError`) naming what happened ("native-mode model
   produced no tool writes and no envelope after one re-prompt") — never a
   silent empty proposal.

`recoveredVia` lands in summary.json. This item is what lets us ship native
mode for qwen without stranding it: worst case it falls back to exactly the
118 behaviour (envelope + T5 rescue), best case it adopts the tools.

D3 is not a hack bolted onto the side — it is precisely the **seam between
the two architectures**. The two-channel (native) path and the envelope
(fallback) path are the same two paths the probe selects between per triple;
the empty-draft net is what happens when a profile *measured* native turns
out to behave like a fallback profile on a given run. The fallback channel
doing its designed job, in other words. It is also the safety margin for the
capability-vs-preference uncertainty: until a native run actually adopts the
tools in the wild, the envelope path is always one re-prompt away.

### D4 — Prompt-budget win, measured

Demotion should shrink the system prompt (the envelope schema paragraph is
~600 chars). Record the native-mode system-prompt length and assert it is
meaningfully smaller than envelope mode in a test; surface the delta in the
blog. This is a concrete payoff of the arc, not just a cleanup.

### D5 — Forensics and `kodr why`

summary.json/`kodr why` gain: resolved `toolWritesMode`, `recoveredVia`
(none/envelope-fallback/envelope-reprompt), and the existing
`proposalChannels`. `kodr why` should make a native run legible: "native
mode: 2 files via write tools, 0 envelope, no fallback needed" vs "native
mode: 0 tool writes, recovered via envelope fallback (T5 split applied)".

## Testing

- D1: native base contract has no `files`/`patches`/`status` schema text,
  has the tool-first sentences; envelope/auto-unresolved byte-identical to
  118 (regression). Per-mode byte-identity coupling test (edit-formats ↔
  context-packer) for native and envelope. Native-mode prefix fixtures.
- D2: native run with a non-empty draft → proposal from draft, trailing text
  is the message, no JSON parse attempted, status from verification (pass and
  fail branches), no ProposalMissingError.
- D3 (all three branches, fake server): empty draft + envelope-shaped JSON →
  envelope-fallback; empty draft + prose → one re-prompt → success records
  envelope-reprompt; empty draft + re-prompt also empty → NativeNoProposalError;
  assert the re-prompt fires at most once.
- D4: native system prompt measurably shorter than envelope mode.
- D5: summary fields present; `kodr why` strings for both native paths.
- Full suite, `npm run format`, `npm run check` green. Existing
  envelope-mode and brownfield-eval tests stay green untouched (scope proof).

## Done criteria

- [x] D1: mode-aware base contract; native drops the envelope schema;
      envelope/auto-unresolved byte-identical to 118; per-mode coupling test.
- [x] D2: native final turn takes the draft as the proposal; trailing text is
      the message; status from verification; no ProposalMissingError.
- [x] D3: empty-draft safety net — envelope-fallback, single envelope-reprompt,
      then NativeNoProposalError; re-prompt fires at most once.
- [x] D4: prompt-budget reduction measured and asserted.
- [x] D5: toolWritesMode + recoveredVia + proposalChannels in summary and
      `kodr why`.
- [x] `process/failures.jsonl` / `process/decisions.jsonl` updated (record the
      phase-118 confound finding as the motivation).
- [x] Blog post `blog/119-envelope-demotion.md`; update `blog/tool-channel-arc.md`
      with the arc's conclusion. (`blog/two-channel-realization.md` —
      the conceptual spine — already written during planning.)
- [x] NEXT.md: delete the Tool-Channel Arc entry (arc complete; history lives
      in the phase files and blog).
- [x] Version bumped to 0.0.119; suite green; committed.
- [x] Live validation (after the commit, sequential, the decisive experiment):
      qwen greenfield in resolved-`native` mode with the envelope contract
      now GONE — does qwen adopt write_file/edit_file, or fall back via D3
      (record which `recoveredVia`)? Either is a pass; the question the whole
      arc has been pointing at gets a real answer. gpt-oss greenfield native —
      confirm no regression from 117 (still tool-native, corruption-free).
      gemma greenfield native — confirm it keeps adopting tools (118 showed it
      does). Record the native-mode prompt-length delta. Devstral remains the
      deferred circle-back (its `files` alias + native mode is the obvious
      follow-up once the three primaries are confirmed).
      RESULT — the confound is disproven and the arc's question answered:
      **qwen ADOPTED the tool channel** (recoveredVia:none, captured:2,
      envelope:0, 5 tool-call turns vs phase-118's single blind 8,720-char
      envelope). The D3 safety net never fired. gpt-oss (captured:4) and
      gemma (captured:2) stayed native, no regression, recoveredVia:none.
      D4 budget delta: native 2,036 vs envelope 3,022 system-prompt chars
      (−986). All three reached verification; two failed on generated CODE
      QUALITY (qwen 8/10, gpt-oss one suite), gemma 6/6 — status-from-
      verification working as designed. Evidence:
      `~/src/kodr-testing/phase-119/` (OPERATOR-REPORT.md),
      `process/failures.jsonl` phase 119-validation.
