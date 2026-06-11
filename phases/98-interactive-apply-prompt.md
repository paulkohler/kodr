# Phase 98: Interactive Apply Prompt

## Goal

Stop paying the model cost twice. Today a CLI dry-run that proposes writes
ends with "re-run with `--yes`", which means a second multi-minute local
inference for the same proposal. The TUI already solved this with the pending
review and `/accept`; the CLI should get the same one-pass flow.

## Design

- When `kodr run` proposes writes without `--yes` on an interactive TTY, show
  the diff summary and prompt `apply? [y/N]` instead of exiting.
- Route the prompt through the shared channel permission-request contract
  (phase 67) — the same pending-review machinery the TUI uses — not a new
  CLI-only code path, per the AGENTS.md rule on shared channel handling.
- Accepting applies the already-proposed writes through the same apply path
  as TUI `/accept`; declining records the proposal as rejected in run
  artifacts. Either way the model is not called again.
- Default answer is No; EOF, timeout, or any non-`y` input declines.
- Non-interactive stdin/stdout, `--json`, and explicit `--dry-run` keep the
  current behavior exactly. `--yes` continues to skip the prompt.
- After an accepted apply, the configured `--test` verification (and phase 97
  heal default) run as if `--yes` had been passed.

## Non-Goals

- No per-file selective apply in the first pass (accept/decline the whole
  proposal).
- No prompt for non-write effects; those stay on the permission policy.

## Done Criteria

- [ ] Interactive dry-run proposals prompt once and apply without a second
      model call.
- [ ] Prompt flows through the shared channel contract with tests at that
      layer.
- [ ] Decline, EOF, and non-TTY paths all fail safe to current behavior.
- [ ] Rejected proposals recorded in run artifacts.
- [ ] Verification and heal run after an accepted apply.
- [ ] Tests for accept, decline, non-TTY, `--json`, and `--yes` paths.
- [ ] Record decisions and any failures.
- [ ] Blog post.
- [ ] Mark roadmap complete and commit.
