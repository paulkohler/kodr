# Phase 43: Session Continuation

## Goal

Let a run pick up where a previous one left off, so a follow-up like
`kodr run -p "yes, do that" --continue` carries the prior conversation. Builds
directly on the transcripts from phase 42.

## Entry points

- `--continue` — read the `.kodr/last-run` pointer, then load that run's
  `conversation.json`.
- `--session <id>` — load `.kodr/runs/<id>/conversation.json` directly (the id
  is the originating run dir basename).

Both then append `{ role: 'user', content: newPrompt }`, run, and write a new
run dir whose `conversation.json` extends the parent's, carrying the same
`sessionId` and setting `parentRunDir` to the run it continued from.

## Design decision: freeze the system prompt (option A)

On continuation, **keep the original system prompt frozen** and append only the
new user turn. Do **not** rebuild workspace context (file map, memory, skills)
each turn. Rebuilding would be "more correct" when `--yes` changed files, but it
double-feeds the context and grows tokens every turn. Freezing is cheap and
deterministic; a context-refresh opt-in can come later if needed.

Continuation is conversation-only: writes, tests, and proposals stay per-turn.
The model sees its prior proposal in the history and re-emits or refines it — no
write/test state needs replaying.

## Edge cases

- Missing/old `conversation.json` (pre-phase-42 runs) → clear error pointing at
  `--session` usage.
- Continuing with a different `--model`/`--provider` than the parent → allowed,
  but warn.
- Growing transcripts mean `--max-tokens`/`--max-cost-usd` matter more (already
  wired via loop budgets).
- `.kodr/last-run` is per-workspace, so `--continue` is naturally cwd-scoped.

## Done Criteria

- [ ] `--continue` resolves and loads the last run's transcript.
- [ ] `--session <id>` resolves and loads the named run's transcript.
- [ ] New run extends `conversation.json`, carries `sessionId`, sets
      `parentRunDir`.
- [ ] System prompt is frozen from the parent (option A), not rebuilt.
- [ ] Warns on model/provider mismatch; errors clearly on missing transcript.
- [ ] Tests cover both resolvers, the chain linkage, freeze behavior, and the
      error/warn paths.
- [ ] Record decisions and any failures.
- [ ] Blog post.
