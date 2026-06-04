# Phase 60: Token-Budget-Aware Context Assembly

## Goal

Make context packing plan against an explicit token budget instead of packing
opportunistically and hoping it fits.

This is the single biggest lever for small local models: a qwen3 with a small
window silently degrades when over-packed. Budgeting prevents that and makes
runs reproducible.

## Design

Before assembly, compute a budget from the model's context window minus a
reserved completion margin. Rank candidate inspection chunks (symbols,
references, related tests) by relevance to the query and fill until the budget
is hit, emitting a summary of what was dropped.

- Reuse the Phase 41 token-usage machinery for counting.
- Reuse the inspection chunk builder in `src/context-packer.mjs` for candidates.
- Add an explicit context-window option with a conservative documented default.
  Phase 68 can later source the same value from model profiles.
- Configurable reserve margin with a sane default.
- Record the active window, reserve, packed estimate, and dropped estimate in
  run artifacts.
- Deterministic given (window, query, index) so it is unit-testable.

## Non-Goals

- No model call to decide relevance.

## Done Criteria

- [ ] Budget function returns a deterministic chunk set for a given
      (window, query, index).
- [ ] Packing never exceeds the configured budget in tests with synthetic large
      indexes.
- [ ] Dropped chunks are reported in a summary block.
- [ ] Add and document an explicit context-window option.
- [ ] Configurable reserve margin with a documented default.
- [ ] Record active context-budget metadata in run artifacts.
- [ ] Add tests.
- [ ] Record decisions and any failures.
- [ ] Blog post.
- [ ] Mark roadmap complete and commit.
