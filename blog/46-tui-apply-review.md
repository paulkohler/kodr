# Phase 46: TUI Apply Review

Phase 46 makes the terminal UI safer for coding turns.

The first TUI could already toggle `/apply on`, but that is too blunt for an interactive coding loop. A user should be able to ask for a change, inspect the proposed writes, then decide what to do with that specific proposal.

Now, when a dry-run TUI turn returns proposed writes, Kodr stores a pending review in the TUI state. The output shows the run dir, session id, write count, proposed paths, model messages, and the review commands:

- `/review`
- `/accept`
- `/reject`
- `/test`

`/accept` applies by sending the same prompt back through the shared run-turn channel with apply enabled. That intentionally reuses the existing `kodr run --yes` path instead of inventing a separate TUI write path. `/reject` clears the pending review. `/test` routes through the central channel too, so the terminal UI is still just an adapter over shared request handling.

The tradeoff is that `/accept` is currently re-run-to-apply rather than apply-from-existing-artifact. That is simpler and preserves the existing safety boundary, but a future phase may want direct artifact application to avoid a second model call.
