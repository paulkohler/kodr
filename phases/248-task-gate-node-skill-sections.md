# Phase 248: Task-gate lang:node SQLite/HTTP skill sections

## Goal

The `lang:node` skill body (~11k chars) is injected into every Node.js prompt
regardless of whether the task touches SQLite or HTTP. For a string-utils task
this is pure noise that buries the behavioural rules. This phase adds per-section
keyword gating so the SQLite pitfalls (~4.8k chars) and HTTP test patterns (~4.9k
chars) only appear when the task prompt actually references those subsystems.

## Motivation

Opus review (phase 247, priority 5) found that the lang:node skill dominates the
system prompt at ~78% of total chars. A simple string-utils task gets ~9.7k chars
of SQLite + HTTP pitfalls it will never use. After gating, such a task gets a
~2.4k-char lang:node block instead of ~12k, roughly halving the total prompt size
and putting the behavioural rules in visible position.

## Design

### Section gating

`gateLanguageGuidance(body, taskContext)` — pure function in `system-env.mjs`:

1. Split the skill body at `## ` headers into preamble + sections.
2. For each section, derive a gate from the header:
   - Header contains "sqlite" → gate: `/sqlite|DatabaseSync|CREATE TABLE/i`
   - Header contains "http" → gate: `/express|node:http|http\.create|server\.listen|app\.listen/i`
   - Header contains "busboy" → gate: `/busboy|multipart|upload/i`
   - Other headers → always include (test isolation, etc.)
3. Include the section if no gate, or if `taskContext` matches the gate.
4. Empty `taskContext` → no filtering (full body, backward compat).

### Plumbing

`options.taskPrompt` is already available in `buildWorkspaceContext`. Thread it as
`taskContext` through: `attachPromptMetadata` → `renderPromptSections` →
`renderStableSection` → `renderLanguageGuidanceBlock` (new `facts.taskContext`
field) → `gateLanguageGuidance`.

### What is always included

- The preamble (ESM rules, node:test, argv, ANSI truncation)
- `## Test isolation — prefer factories over ESM cache busting`
- Any explicitly gated section whose keywords appear in the task prompt

## Done criteria

- [x] `gateLanguageGuidance` exported from `system-env.mjs`, pure, no deps.
- [x] SQLite section absent from prompt when task has no sqlite/database keywords.
- [x] HTTP section absent from prompt when task has no express/server keywords.
- [x] Empty / missing `taskContext` returns the full ungated body (backward compat).
- [x] `renderLanguageGuidanceBlock` with no `taskContext` is byte-identical to before.
- [x] Tests pass; `npm run check` clean.
