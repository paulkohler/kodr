# Phase 68: Model Profile And Capability Registry

## Goal

Centralize model capabilities so local-model behavior is predictable.

Small local models vary widely in context window, timeout needs, tool-call
support, streaming quality, and JSON reliability. These properties should be
explicit configuration, not scattered assumptions.

## Design

Add a model profile registry with defaults for known local-first models and an
override path for project/user config.

Profiles should include:

- model id
- provider/base URL
- context window
- completion reserve
- timeout
- native tool-call support
- recommended response-envelope mode

Use the profile when assembling context, setting request timeouts, and deciding
whether native tools are available. Derive the default session compaction budget
from the active profile while preserving `--session-context-chars` as an
explicit override.

## Non-Goals

- No model benchmarking in this phase.
- No remote model catalog sync.
- No automatic LM Studio settings mutation.

## Done Criteria

- [ ] Add model profile loading with local defaults and config overrides.
- [ ] Use profiles for context budget and timeout defaults.
- [ ] Use profiles for the default session compaction budget without overriding
      an explicit CLI value.
- [ ] Expose active profile in run/session metadata.
- [ ] Add tests for default, override, and unknown-model fallback.
- [ ] Record decisions and any failures.
- [ ] Blog post.
- [ ] Mark roadmap complete and commit.
