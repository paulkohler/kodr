# Phase 57: Persistent Planning Scratchpad

## Goal

Feed the last turn's scratchpad back into the next turn's context so the model
can write a plan, tick items off across turns, and recover from partial failures
without losing state.

## Motivation

Phases 54-56 showed the self-dev loop working well for narrow patches (≤6
changes, exact search strings known in advance). The upcoming phases (58-61)
are broader — multiple files, exploratory decisions, uncertain patch counts.
Carrying structured state between turns lets the model plan first and execute
incrementally without the human pre-writing every search string.

Tools were considered. Context injection wins for the base case: the scratchpad
is always small, always relevant, and auto-injecting it requires no extra
round-trip and no model memory. A `read_scratchpad(turn)` tool is reserved for
a future phase if reaching back more than one turn becomes necessary.

## Behaviour

When `runPrompt` starts a turn that is not the first in a session, Kodr appends
a `## Prior scratchpad` section to the user message (or system prompt) containing
the raw scratchpad string from the previous turn.

The model convention (documented in system prompt guidance) is to use the
scratchpad field as structured JSON:

```json
{
  "plan": ["step 1", "step 2", "step 3"],
  "done": ["step 1"],
  "next": "step 2",
  "notes": "optional free text"
}
```

Kodr does not validate or parse this structure — it passes the raw string
through. The convention is enforced only by prompt guidance.

## Design

- `runPrompt` receives the prior scratchpad string as an optional option
  (`options.priorScratchpad`).
- When present and non-empty, append a `## Prior scratchpad\n\n<content>` block
  to the assembled user message, after the main prompt content.
- Session/workflow callers pass the scratchpad from the previous result forward.
- Single-shot `kodr run` passes nothing (no change to current behaviour).

## Non-Goals

- No parsing or validation of scratchpad JSON.
- No scratchpad history beyond one turn (no `read_scratchpad` tool yet).
- No TUI surface for scratchpad content.
- No persistence to disk beyond what session transcripts already capture.

## Done Criteria

- [x] `runPrompt` accepts `options.priorScratchpadPath` and injects content into user message.
- [x] `last` alias resolves via `.kodr/last-run` pointer.
- [x] System prompt updated with structured scratchpad convention.
- [x] Tests: no injection, injection present, empty skipped, missing file skipped, truncation, `last` alias.
- [x] `npm run format` and `npm run check` pass.
- [x] Record decisions.
- [x] Blog post.
- [x] Mark roadmap complete and commit.

## Self-Dev Notes

This is a good self-dev candidate. The changes touch `src/context-packer.mjs`
(or wherever the user message is assembled) and the workflow loop in
`src/app.mjs` or the session runner. Three to four patches, no new files.

When writing the self-dev prompt, name both locations explicitly:
1. `runPrompt` / context assembly — inject prior scratchpad into user message
2. Workflow turn loop — pass `result.scratchpad` as `priorScratchpad` on next
   iteration
3. System prompt guidance — add the structured JSON convention
