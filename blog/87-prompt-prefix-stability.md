# Phase 87: Prompt Prefix Stability

Phase 86 made prompt caching visible and provider-aware. Phase 87 addresses the
next problem: the beginning of the prompt needs to stay stable for cache hits to
be likely.

Kodr previously rendered one large system prompt by appending whichever context
was available: harness contract, AGENTS.md, memory, skills, file map, packed
source, and inspection output. That worked, but it meant a source-file change
could move or rewrite text near the beginning of the request. Remote providers
with automatic prefix caching care about the byte-identical token stream at the
start, so this made cache behavior hard to reason about.

The context packer now renders four named sections:

- stable: Kodr identity, safety rules, tool and response-envelope contract;
- project: AGENTS.md repository instructions;
- semi-stable: memory and loaded Markdown skills;
- volatile: file maps, packed source, inspection chunks, omitted-file notes.

For compatibility, Kodr still sends one system message to OpenAI-compatible
servers. Some local servers are stricter than hosted APIs, and changing to
multiple system messages would be a risky compatibility break. Instead, the
single message is built from the named sections in deterministic order. That
keeps the stable prefix first while preserving the existing request shape.

Every run now writes `prompt-prefix.json` and mirrors the same metadata into
`summary.json`. The artifact records short hashes and character counts for the
stable, project, semi-stable, and volatile sections. Subagent stage directories
also get their own `prompt-prefix.json`, so planner, implementer, and reviewer
requests can be inspected independently.

The tests cover the important behavior:

- changing a source file changes the volatile hash but not the stable or project
  hashes;
- changing AGENTS.md changes the project hash;
- changing a loaded skill changes the semi-stable section;
- standard run summaries and subagent artifacts expose the metadata.

This does not guarantee provider cache hits. It makes the prompt prefix
measurable, stable by construction, and ready for future provider-specific
message layouts when a model profile can safely opt into them.
