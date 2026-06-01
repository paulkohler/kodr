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
- pack repair turns around the failing file, failing test output, and nearby
  source instead of reusing broad app-generation context
- treat OK envelopes with zero files/patches plus a non-empty scratchpad as
  no-progress repair turns, not successful convergence
- stay bounded by the existing loop budget (Phase 33)
- enforce a wall-clock timeout for the whole repair turn and write failure
  artifacts even when the model transport never returns

Builds directly on the turn-forwarding wiring introduced in Phase 62.

## Non-Goals

- No git integration (that is Phase 73).
- No new model providers or streaming changes.

## Done Criteria

- [x] Workflow loop forwards scratchpad and plan automatically across turns
      (test with a fake 2-turn model).
- [x] Verification failure text is injected into the subsequent turn.
- [x] Repair context includes `tests.json`, the failing path, and nearby source
      while excluding unrelated generated files unless explicitly requested.
- [x] Loop terminates on success, budget exhaustion, or no-progress (snapshot
      diff empty twice).
- [x] Hung repair calls fail with artifacted timeout details instead of leaving
      only partial `context.md`, `prompt.md`, and `raw-request.json` files.
- [x] OK/no-op proposals that only add scratchpad content are forwarded once,
      then counted as no-progress if they repeat.
- [x] Repair proposals are checked against failing stack traces/requested paths;
      creating a similarly named sibling file does not count as convergence.
- [x] Snapshot diff captured per turn as an artifact.
- [x] Add tests.
- [x] Record decisions and any failures.
- [x] Blog post.
- [x] Mark roadmap complete and commit.
