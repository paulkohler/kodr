# Phase 152 — Orchestration Tool-Channel Parity

## Motivation

The multi-agent path is the last place still reading writes only from the text
envelope. `runAgentCompletion` runs subagents through `completeWithToolCalls` with
a `createBuiltinRegistry` (capture tools → `proposalDraft`), and the returned
`completion.proposalDraft` holds any writes the model made via `write_file` /
`edit_file`. But the two callers read only the envelope:

- `orchestration.mjs:426` (implementer): `extractProposal(completion.text)`
- `orchestration.mjs:776` (file-author): `extractProposal(completion.text)`

`proposalDraft` is never referenced in `orchestration.mjs`. So a model that writes
via the tool channel and emits no JSON envelope has its writes **silently
dropped** — the phase-135 bug class, unfixed in orchestration, and an AGENTS.md
"route new user-facing surfaces through shared channel/request handling" violation.
Model-dependent: qwen emits the envelope and works; gpt-oss uses tools
exclusively and would lose everything.

(Verified against current code, not just the NEXT.md note: both implementer and
file-author build registries via `createBuiltinRegistry`, `completeWithToolCalls`
returns `proposalDraft`, and neither call site consults it.)

## Fix

Add a shared resolver to `tool-calls.mjs` (the channel module that already owns
`mergeProposalWithDraft` and imports `extractProposal`):

```js
export function resolveProposalFromCompletion(completion) {
  const draft = completion?.proposalDraft ?? null;
  const draftNonEmpty = draft !== null && !draft.isEmpty;
  const envelopeProposal = extractProposal(completion?.text ?? '');
  if (draftNonEmpty || (draft !== null && envelopeProposal !== null)) {
    return mergeProposalWithDraft(draft, envelopeProposal);
  }
  return envelopeProposal;
}
```

This mirrors the run-pipeline merge rules (phase 135): tool writes alone →
synthesize a proposal; envelope alone → unchanged (no regression for qwen); both →
merge with the envelope winning per path. Route both orchestration call sites
through it (`extractProposal` becomes unused there and is dropped from the import).

## Testing

- Unit (`tool-calls.test.mjs`): `resolveProposalFromCompletion` for draft-only
  (synthesized), envelope-only (passthrough, no regression), both (merged), and
  neither (null).
- Live validation (AGENTS.md): a `--subagent-stages` staged run against gpt-oss
  (loaded locally) writes files via the tool channel and the orchestration result
  now contains them.

## Out of scope / follow-up

- Steering `roles/implementer` + `roles/file-author` SKILL.md to "write via tools;
  envelope is fallback." The code fix makes tool writes count regardless of the
  steer; the steer is a separate, prompt-only nudge.

## Done criteria

- [x] `resolveProposalFromCompletion` added to `tool-calls.mjs`; both orchestration
      call sites routed through it; tool-channel writes no longer dropped.
- [x] No regression for envelope-only models (qwen path returns the same proposal —
      unit test + empty-draft passthrough test).
- [x] Unit tests added (5); `npm run check` + `format` + full suite green (1,470).
- [x] Live `--subagent-stages` gpt-oss validation: file-author `proposal.json`
      `_extractionMeta.channels` = `{captured:1, envelope:1, merged:1}` — the
      tool-channel write is now counted (was dropped pre-fix).
- [x] Blog `blog/152-orchestration-tool-channel-parity.md`; decisions entry;
      NEXT.md trimmed (generation-params item was stale — temp:0 + response_format
      already ship); roadmap line; version 0.0.152.
