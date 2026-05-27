# Phase 32: Response Envelope

## Goal

Move Kodr's proposal schema out of user prompt files and into the system prompt, with an explicit response envelope that can carry status and messages.

## Scope

- [x] Add a centralized response envelope contract to the system prompt.
- [x] Accept `status`, `messages`, `files`, `patches`, and `scratchpad` from model proposals.
- [x] Record proposal messages as run artifacts.
- [x] Treat `status: "ERROR"` as a failed run without applying writes.
- [x] Remove inline JSON-shape boilerplate from active Markdown-search prompt fixtures.

## Done Criteria

- [x] Tests cover OK envelopes, ERROR envelopes, messages artifacts, and legacy proposal compatibility.
- [x] Prompt fixtures no longer need to repeat the JSON object schema.
- [x] Blog post documents the prompt-contract split.
- [x] Tests pass.
