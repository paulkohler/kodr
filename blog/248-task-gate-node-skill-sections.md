# Phase 248: Task-gate lang:node SQLite/HTTP skill sections

The Opus review (phase 247) flagged that the `lang:node` skill body dominates
the system prompt — roughly 78% of total chars — regardless of what the task
actually does. A "write a slugify function" task gets 9.7k chars of SQLite
pitfalls and HTTP integration patterns it will never use. This phase fixes that.

## The fix

A new `gateLanguageGuidance(body, taskContext)` function in `system-env.mjs`
splits the skill body into sections by `## ` header and applies per-section
gate rules:

| Header keyword | Gate pattern                                                    |
|----------------|-----------------------------------------------------------------|
| `sqlite`       | `/sqlite\|DatabaseSync\|CREATE TABLE/i`                       |
| `http`         | `/express\|node:http\|http\.create\|server\.listen\|app\.listen/i` |
| `busboy`       | `/busboy\|multipart\|upload/i`                                 |
| other (test isolation, etc.) | always included                           |

The preamble (ESM rules, node:test, argv, ANSI truncation) is always included.

When `taskContext` is empty or absent, the full body is returned — no change in
behaviour for callers that don't supply a task prompt.

## Plumbing

`options.taskPrompt` was already flowing into `buildWorkspaceContext` for
language detection (`detectNodeEsm`). This phase adds it to all three
`attachPromptMetadata` call sites as `taskContext: options.taskPrompt || ''`,
then threads it through `renderPromptSections` → `renderStableSection` →
`renderLanguageGuidanceBlock` → `gateLanguageGuidance`.

No SKILL.md changes needed — the gate logic is purely in `system-env.mjs`.

## Size impact

For a simple string-utils task (no sqlite/http/busboy keywords), the lang:node
section drops from ~12k chars to ~2.4k chars (~80% reduction). The full system
prompt shrinks from ~15k to ~5k — a 66% reduction. The behavioural rules that
were buried under 9k chars of pitfalls are now the majority of the prompt.

The size tests verify this: a gated prompt for a plain task must be at least 40%
smaller than an ungated one.

## Backward compat

- Callers that don't pass `taskPrompt` (including all existing tests) get the
  full unfiltered body exactly as before.
- The `renderLanguageGuidanceBlock({ isNodeEsm: true })` form is byte-identical
  to pre-248 (no `taskContext` → no gating).
