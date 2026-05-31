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

## Non-Goals

- No vector database.
- No lossy deletion of raw transcripts; preserve artifacts on disk.
- No cross-project memory.

## Done Criteria

- [ ] Add a compact session summary artifact.
- [ ] Inject compact summaries into continued sessions when transcript budget is
      exceeded.
- [ ] Preserve raw transcripts separately.
- [ ] Add tests for compaction triggers and injected summary shape.
- [ ] Record decisions and any failures.
- [ ] Blog post.
- [ ] Mark roadmap complete and commit.
