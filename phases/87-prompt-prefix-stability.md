# Phase 87: Prompt Prefix Stability

## Goal

Improve real prompt-cache hit rates by making the beginning of Kodr model
requests more stable across turns and runs, without weakening the current
system prompt contract.

Phase 86 added provider-aware prompt-cache controls and usage reporting. This
phase is about prompt layout: keeping the stable harness identity and long-lived
project instructions byte-identical for longer, while moving volatile workspace
context later in the request.

## Context

Kodr currently sends one large `system` message. It includes:

- harness identity and response contract
- AGENTS.md
- memory
- skills
- file map or packed workspace context
- response envelope instructions

That is simple and works, but it makes provider prefix caches fragile. A small
file-map change, memory update, loaded skill, or packed file change can alter
the first token stream and miss the cache even when the core harness contract is
unchanged.

The target is not to guarantee cache hits. The target is to make the stable
prefix obvious, testable, and durable enough that remote providers with
automatic prefix caching can reuse it when only the user prompt or volatile
workspace context changes.

## Design

Split context construction into named sections with explicit stability levels:

- `stable`: Kodr harness identity, response contract, safety rules, tool
  contract, output envelope.
- `project`: AGENTS.md and project-level instructions.
- `semiStable`: loaded Markdown skills and project memory.
- `volatile`: file map, packed source, inspection chunks, session summaries,
  prior scratchpad, and current user prompt.

For OpenAI-compatible chat completions, preserve the API shape but make the
message order intentional:

```json
[
  { "role": "system", "content": "<stable harness contract>" },
  { "role": "system", "content": "<project instructions>" },
  { "role": "system", "content": "<semi-stable skills/memory>" },
  { "role": "user", "content": "<volatile workspace context>\n\n<user prompt>" }
]
```

If a provider rejects multiple `system` messages, fall back to a single system
message but keep the section renderer deterministic so future adapters can
split it safely.

## Stability Metrics

Add artifact metadata that lets us inspect prefix stability:

```json
{
  "promptPrefix": {
    "stableHash": "...",
    "projectHash": "...",
    "semiStableHash": "...",
    "volatileHash": "...",
    "stableChars": 1234,
    "projectChars": 456
  }
}
```

This should appear in `summary.json` or a small `prompt-prefix.json` artifact.
The goal is to see whether repeated runs are really preserving the prefix.

## Tests

Add deterministic tests:

- two prompts in the same unchanged workspace have identical stable and project
  hashes
- changing a source file changes only volatile hashes
- changing AGENTS.md changes project hash
- loaded skills change semi-stable hash
- session continuation still preserves the parent system contract
- raw request ordering is stable for standard and subagent runs

## Non-Goals

- No provider-specific Anthropic content-block breakpoint selection.
- No prompt compression model call.
- No semantic retrieval or embeddings.
- No removal of existing AGENTS.md or memory behavior.
- No compatibility break for existing local OpenAI-compatible servers.

## Open Questions

- Should volatile workspace context remain a `system` message or move to the
  first `user` message for better cache behavior?
- Which local OpenAI-compatible servers reject multiple system messages?
- Should provider capability profiles choose single-system or multi-system
  request layout?
- Should prompt-prefix hashes be included in session browsing output?

## Done Criteria

- [ ] Context rendering exposes stable/project/semi-stable/volatile sections.
- [ ] Raw model requests keep stable sections before volatile sections.
- [ ] A compatibility fallback preserves single-system-message behavior when
      needed.
- [ ] Prompt-prefix hashes are artifacted.
- [ ] Tests prove stable hashes survive ordinary user-prompt changes.
- [ ] Tests prove volatile source changes do not rewrite the stable prefix.
- [ ] Update `usage.md`.
- [ ] Record decisions and failures.
- [ ] Blog post.
- [ ] Mark roadmap complete and commit.
