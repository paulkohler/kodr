# Phase 152: Orchestration Tool-Channel Parity

Phase 117 taught Kodr's main run loop to capture writes from the *tool channel*
(`write_file` / `edit_file` calls), not just the JSON envelope a model prints in
its text. Phase 135 then made the loop *prefer* those captured writes, with the
envelope as fallback — because some local models (gpt-oss in particular) write
exclusively via tools and emit no envelope at all. Drop the tool channel and those
models look like they did nothing.

The multi-agent path never got that memo. `runAgentCompletion` runs each subagent
through `completeWithToolCalls` with a `createBuiltinRegistry` — so the capture
tools are wired and `completion.proposalDraft` holds whatever the model wrote via
tools. But both callers read only the envelope:

```js
// implementer (orchestration.mjs:426) and file-author (:776)
const proposal = extractProposal(completion.text);
```

`proposalDraft` appeared *nowhere* in `orchestration.mjs`. So an implementer or
file-author subagent running on a tool-only model wrote its files into a draft
that the orchestrator then ignored — the phase-135 bug, alive in the one place
still on the envelope island, and an AGENTS.md "route through shared channel
handling" violation.

## Verify before fixing

The standing lesson on this project is to re-derive a claim from the code, not
trust the note. The NEXT.md entry asserted the bug; the code confirmed it exactly:
both subagent registries are built with `createBuiltinRegistry` (capture tools →
`proposalDraft`), `completeWithToolCalls` returns that draft, and neither call site
consulted it. A related claim in the *same* backlog — "Kodr sends only
`{messages, model, tools}`, no temperature" — turned out **stale**: both completion
paths already pin `temperature: 0` and `response_format` shipped in phase 112. So
the generation-params item got trimmed from NEXT.md instead of implemented.

## The fix: one shared resolver

`tool-calls.mjs` already owns `mergeProposalWithDraft` and imports
`extractProposal`, so the resolver belongs there, not duplicated per call site:

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

It mirrors the run-pipeline rules: tools-only → synthesize a proposal from the
draft; envelope-only → return it unchanged (qwen is unaffected — no regression);
both → merge with the envelope winning per path. The two orchestration call sites
now call it; `extractProposal` is no longer used there.

## Proof on the real model

A `--subagent-stages` run against the loaded `openai/gpt-oss-20b` produced a
file-author `proposal.json` with:

```json
"_extractionMeta": { "channels": { "captured": 1, "envelope": 1, "merged": 1 } }
```

`captured: 1` is the tool-channel write being counted — the exact thing the old
code threw away. The file (`src/calc.mjs`) propagated up to the orchestration
result (`proposalFound: true`, `writeCount: 1`). (The run's `ok: false` is a
dry-run artefact: the reviewer checks the disk and `--dry-run` applies nothing —
unrelated to the capture, which is what this phase fixes.)

Five unit tests cover the resolver directly (draft-only, envelope-only,
empty-draft passthrough, merge, neither); full suite 1,470 green.
