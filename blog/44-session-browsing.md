# Phase 44: Session Browsing

Phases 42–44 are a trilogy: 42 wrote the transcript, 43 let you resume it, and
44 lets you see what you've built.

```
$ kodr session list
2026-05-29T10-00-00.000Z  turns=3  [ok]  qwen/qwen3.6-35b-a3b
2026-05-29T14-30-00.000Z  turns=1  [ok]  qwen/qwen3.6-35b-a3b

$ kodr session show 2026-05-29T10-00-00.000Z
Session: 2026-05-29T10-00-00.000Z

Turn 1  [ok]  qwen/qwen3.6-35b-a3b  tokens=1234
  User: Write a greet.mjs module that says hello
  Assistant: Here is the implementation: ...

Turn 2  [ok]  qwen/qwen3.6-35b-a3b  tokens=889
  User: Also add a farewell function
  Assistant: I've updated the module to include...

Turn 3  [ok]  qwen/qwen3.6-35b-a3b  tokens=712
  User: yes, do that
  Assistant: Done. The changes are applied...
```

## How it works

`scanSessions` in `run-history.mjs` scans `.kodr/runs/`, reads each `summary.json`,
groups dirs by `sessionId`, and sorts the groups chronologically. It reuses the
same directory-scanning pattern as `scanRunHistory` — no new infrastructure.

`loadSessionConversation` then reads `conversation.json` from each run in the
session. Each run's transcript ends with `[… user, assistant]`. Extracting the
last pair gives the semantic turn: one question, one answer. Multi-turn
transcripts (with continuation messages in between) are represented as a single
entry per run, which is the level of detail that's useful for browsing.

`kodr session show` truncates assistant replies at 120 chars in the human output —
enough to recognise the response without flooding the terminal. The full content
is always in the run dir's `response.md` and `conversation.json`.

`--json` mode returns the full turn array including token counts and run dirs, so
it can be consumed programmatically or piped into further tools.

## What's next

The session machinery (42–44) is the foundation for more ambitious features:
`session heal` (re-run the last failing turn), `session diff` (compare two
branches of the same session that diverged at a choice point), or integrating
session context into the eval suite. None of those require infrastructure changes
— they compose directly on top of `conversation.json` and the chain links.
