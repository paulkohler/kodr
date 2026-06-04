# Phase 69: Session Compaction And Summaries

## Goal

Keep long sessions usable with small context windows by compacting older turns
into bounded summaries.

This is core local-model infrastructure. Without compaction, the harness either
over-packs context or loses the thread during multi-turn work.

## Design

Add deterministic session compaction that summarizes:

- user intent and constraints
- files changed
- current plan and remaining tasks
- verification failures
- important tool outputs
- decisions that must persist

Prefer extractive summaries from existing artifacts where possible. If a model
summary is used later, it must be clearly marked as model-generated and bounded.

Use a character budget for this phase because Kodr does not yet have the
model-profile context-window data planned in Phase 68 or a provider-neutral
tokenizer. The default is 48,000 characters and can be overridden with
`--session-context-chars`.

`conversation.json` records the compact model-facing transcript.
`conversation-raw.json` records the complete transcript chain and is preferred
when loading the next continuation. `session-summary.json` records the
deterministic extractive summary and compaction metadata.

Inject the summary as explicitly untrusted historical user context. It contains
prior user, assistant, tool, and artifact text and must not be promoted to
system-message authority.

## Non-Goals

- No vector database.
- No lossy deletion of raw transcripts; preserve artifacts on disk.
- No cross-project memory.

## Done Criteria

- [x] Add a compact session summary artifact.
- [x] Inject compact summaries into continued sessions when transcript budget is
      exceeded.
- [x] Preserve raw transcripts separately.
- [x] Add tests for compaction triggers and injected summary shape.
- [x] Record decisions and any failures.
- [x] Blog post.
- [x] Mark roadmap complete and commit.
