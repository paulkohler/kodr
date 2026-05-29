# Phase 49: Channel Contract Tests

Phase 49 hardens the channel boundary that now sits underneath CLI and TUI behavior.

The concern is drift. Once there is more than one way to talk to Kodr, it becomes easy for the command line, terminal UI, and future web UI to each learn their own slightly different run/session behavior. The channel handler is supposed to prevent that, so this phase adds contract tests around it.

The new tests check that CLI and channel run turns produce the same artifact shape, that session list/show requests work without presentation code, that unknown channel requests fail clearly, that TUI slash commands do not reach the model channel, and that TUI turns do not mutate their base option template.

There is little product surface in this phase. That is intentional: the contract tests protect the product surface added in phases 45 through 48 and make the next channel, a small web sketch, less risky.
