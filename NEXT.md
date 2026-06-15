# NEXT

Loose, forward-looking candidates only — the rough shape of phases not yet
written. Not a commitment; promote an item into `roadmap.md` + `phases/` when
it is actually next. **Delete an item the moment it ships** — history lives in
the roadmap, phase files, and blog, not here. If a cut idea was really needed it
will resurface on its own.

Current frontier (phase 147): the plumbing works — extraction, transport,
channels and routing are hardened against real local-model output. The live
failures are now in the *code the local models write* and at *transport edges*
(token-limit truncation, role alternation).

## Candidates

### Per-step model routing
`--route-auto` (141) picks the best-history model at run start. The open half is
splitting *within* a run: cheap tasks (commit messages, compaction, summaries)
to a `cheapModel`, edits to `editModel`, recording the per-step choice in the
summary so `kodr why` shows which model handled which step. Bigger and riskier —
it touches several internal model-call sites; the `cheapModel` recommendation
can extend `recommendModel`.

### Control generation params at the source (supersedes the 147 "truncation" item)
Kodr sends only `{messages, model, tools}` to LM Studio — no `temperature`,
`max_tokens`, `repeat_penalty`, or `response_format` — so it inherits each
model's chat-tuned GUI preset (qwen: temp 0.8, repeat_penalty 1.1). The phase-147
"lost envelope" was NOT a token-limit truncation: `finish_reason=stop`, 2309
completion tokens against a 262144 context, no cap; the model emitted a malformed
JSON envelope capped by a stray `</parameter>` tool-template token. Levers, all
per-request via the OpenAI `/v1` API (no model reload):
- Lower `temperature` (and `repeat_penalty` → 1.0) for code/structured output.
- Optionally `response_format` json_schema to grammar-constrain the **envelope**
  channel — would make the R0–R6 repair rules unnecessary for that path (verify
  the server allows `tools` + `response_format` together first).
- Set a generous explicit `max_tokens` so a real cap is known, not inherited.
Record the chosen params in `summary` so `kodr why` shows them. Context length
and context-overflow policy are load-time (`lms` CLI / SDK), not per-request;
Kodr already reads the loaded context window via the management API (146).

### Bring orchestration to tool-channel parity (envelope island)
The multi-agent path (implementer, file-author) is the last place still on the
pre-117 text envelope. `runAgentCompletion` gives subagents `write_file`/
`edit_file` and runs them through `completeWithToolCalls` (which captures tool
writes into `proposalDraft`), but the callers read only the text envelope —
`extractProposal(completion.text)` at orchestration.mjs:426 (implementer) and
:776 (file-author); `proposalDraft` is ignored. So a model that writes via the
tool channel has its writes silently dropped — the phase-135 bug class, unfixed
here. Model-dependent: qwen emits the envelope and works; gpt-oss uses tools
exclusively (stocktake) and would lose everything. The envelope steer is weakest
where it's needed — `response_format` is `none` for local models. Fix: prefer
`completion.proposalDraft` (135 pattern) with envelope fallback in both callers,
then update `roles/file-author` and `roles/implementer` SKILL.md to "write via
tools; envelope is fallback." Validate with a live gpt-oss staged run. (Also an
AGENTS.md "route through shared channel handling" violation.)

### Multi-file coordinated edits
The eval suite only measures single-defect fixes. Plant a cross-file refactor
fixture and measure it — this exposes whether plan manifests (91) and
file-author subagents (92) actually compose. Bigger swing. **Requires a retest**
— re-validate that this is still a gap against current plan-manifest/subagent
behaviour before promoting it to a phase.

### Re-decide the @kodr/repomap publish hold
Parked by decision (2026-06-12: no publish until more dogfooding); the
precondition is now met, so this needs a human call and won't resurface on its
own. The `packages/repomap/src/` tree is a manual copy of `src/repomap/`; a sync
check (a test that fails when the trees diverge) can land regardless of the
publish decision.
