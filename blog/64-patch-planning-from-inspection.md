# Phase 64: Patch Planning From Inspection

Inspection-aware context gave Kodr better chunks to show a model, but it still
left the model to infer an edit plan from those chunks. Phase 64 makes that
first step deterministic.

When inspection context is available, Kodr now writes an `inspection-plan.json`
artifact containing:

- likely target files
- likely target symbols
- related tests
- suggested verification commands
- risk notes

The plan is generated without a model call. It uses the structural index, ranks
symbols against the user's request, avoids selecting tests as primary edit
targets when source symbols are available, and then looks for nearby test files.
Suggested verification commands are intentionally conservative: they are passed
through the existing verification allowlist before they can appear in the plan.
That prevents Kodr from suggesting a command that its own verifier would later
reject.

The rendered plan is injected before the user's request for inspection-aware
runs. That gives small local models a concise navigation hint such as "edit
`src/app.mjs`, inspect `runPrompt`, and run `node --test test/app.test.mjs`"
instead of asking them to derive the same path from the full context.

This phase also closed a workflow gap. Persistent scratchpads and plans were
useful for explicit single runs, but multi-cycle workflows did not automatically
carry them from one turn to the next. The cycle runner now forwards the
inspection plan and prior scratchpad as a compact handoff. Future plan/execute
work can build on that instead of inventing another state channel.

The main tradeoff is that the plan is heuristic. It is not a semantic type
system and it does not claim certainty. The artifact is therefore framed as
targeting guidance, not as a hard edit boundary. The model can still inspect and
edit other files when needed, while Kodr keeps the likely path obvious.

Tests cover deterministic plan generation, allowlisted verification suggestions,
prompt injection for `--inspect-context`, and forwarding plan/scratchpad state
across a two-cycle workflow.
