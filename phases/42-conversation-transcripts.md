# Phase 42: Conversation Transcripts

## Goal

Make every run persist a complete, reusable conversation transcript. This is the
prerequisite for session continuation (phase 43): today there is no artifact you
can load and hand back to the model as "the conversation so far."

## The bug this fixes

`completeWithContinuations` returns immediately on a non-`length` finish
**without appending the assistant's reply to the message array**. So a normal
run's `raw-request.json` holds only `['system', 'user']` — the model's answer
lives in `response.md` and `raw-response.json` but never in a transcript. The
tool-calls path appends assistant/tool messages mid-loop but also drops the
final assistant turn. Both need to return a transcript that ends with the
assistant's last message.

## Design

- Have the completion functions (or `app.mjs`) produce a canonical transcript:
  the full `messages` array including the final assistant turn (and any tool
  messages for the `--tools` path).
- Write `conversation.json` per run: the complete message list up to and
  including this run's assistant turn.
- Add `sessionId` and `parentRunDir` to `summary.json`. For a fresh run,
  `sessionId` is the run dir basename and `parentRunDir` is null.
- Write a per-workspace `.kodr/last-run` pointer file recording the most recent
  run dir.
- Keep run dirs immutable and independent — a session is a parent-linked chain,
  not a new directory layout. Replay, prompt-history, and per-run artifacts stay
  unchanged.

## Done Criteria

- [ ] `conversation.json` written for every run, ending with the assistant turn.
- [ ] Tool-call runs preserve `assistant`/`tool` messages in the transcript.
- [ ] `summary.json` carries `sessionId` and `parentRunDir`.
- [ ] `.kodr/last-run` pointer updated each run.
- [ ] Tests cover transcript completeness for the buffered, continuation, and
      tool-call paths, plus the pointer write.
- [ ] Record decisions and any failures.
- [ ] Blog post.
