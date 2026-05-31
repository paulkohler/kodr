# Phase 71: Multi-Turn Self-Healing Loop

## Goal

Turn one-shot healing (Phase 13) into a stateful loop that carries plan, diff,
and failure context across turns until it converges or runs out of budget.

Small models rarely one-shot a multi-file change. Carrying plan + diff + failure
across turns is what lets a forgetful local model actually converge.

## Design

Wire the `workflow.mjs` / `cycles.mjs` loop to:

- auto-forward the prior scratchpad and inspection-derived plan (Phases 57/62)
  into the next turn without an explicit flag
- capture a workspace snapshot diff after each turn as the progress/failure
  signal
- feed verification failure output back into the next turn's prompt
- treat OK envelopes with zero files/patches plus a non-empty scratchpad as
  no-progress repair turns, not successful convergence
- stay bounded by the existing loop budget (Phase 33)

Builds directly on the turn-forwarding wiring introduced in Phase 62.

## Non-Goals

- No git integration (that is Phase 72).
- No new model providers or streaming changes.

## Done Criteria

- [ ] Workflow loop forwards scratchpad and plan automatically across turns
      (test with a fake 2-turn model).
- [ ] Verification failure text is injected into the subsequent turn.
- [ ] Loop terminates on success, budget exhaustion, or no-progress (snapshot
      diff empty twice).
- [ ] OK/no-op proposals that only add scratchpad content are forwarded once,
      then counted as no-progress if they repeat.
- [ ] Repair proposals are checked against failing stack traces/requested paths;
      creating a similarly named sibling file does not count as convergence.
- [ ] Snapshot diff captured per turn as an artifact.
- [ ] Add tests.
- [ ] Record decisions and any failures.
- [ ] Blog post.
- [ ] Mark roadmap complete and commit.
