# Phase 29: Memory And Scratchpad

The CSV redo showed that Kodr needed a place for durable intent that was neither the roadmap nor a prompt one-off. Patch proposals fixed the edit surface, but the model still needed clearer state about what had already failed, what should be retried, and which preferences should persist.

This phase adds three scopes:

- Project memory: `KODR_MEMORY.md`, committed with the repo and loaded as untrusted project guidance.
- Private user memory: `.koder/memory/user.md`, local-only because `.koder` is ignored by context walking and should not be committed by default.
- Run scratchpad: `scratchpad.md` inside each run artifact directory, populated from an optional `scratchpad` string in the model proposal.

The system prompt now tells the model it can include short run-local scratchpad notes alongside `files` and `patches`. Scratchpad content is not applied to the workspace; it is recorded as an artifact for review and future diagnostics.

This keeps persistence explicit. Project memory is visible and reviewable, user memory stays out of committed files by default, and scratchpads capture transient repair notes without becoming repo state.
