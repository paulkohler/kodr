# Phase 70: Session Compaction And Summaries

Session continuation originally sent the complete previous conversation back to
the model on every turn. That is simple and faithful, but it eventually makes a
long session unusable for a small local model.

Phase 70 adds deterministic session compaction. When a continued transcript
exceeds the configured character budget, Kodr keeps the frozen system prompt
and the newest user-led turns, then replaces older turns with an extractive
summary. The summary gathers user intent, constraints, changed file paths,
remaining tasks, verification failures, important tool output, and decisions
from existing artifacts.

This phase deliberately uses characters rather than claiming exact token
accounting. Kodr does not yet have the model-profile context-window data planned
for Phase 69 or a provider-neutral tokenizer. The default budget is 48,000
characters and `--session-context-chars` makes it explicit and testable.

The artifact split matters:

- `conversation.json` is the transcript actually sent to the model;
- `conversation-raw.json` preserves the complete session chain;
- `session-summary.json` records the extractive summary and compaction metadata.

Future continuations prefer the raw transcript, so compaction does not
progressively summarize an already summarized conversation. Raw history remains
available for browsing and debugging even when the model receives a smaller
context.

The summary is injected as explicitly untrusted historical user context. It is
not a system message, because prior user, assistant, tool, and artifact text
must not gain higher instruction priority through compaction.

Kodr also never truncates the current user turn to force it under budget. If the
frozen system prompt and active request are themselves too large, the summary
artifact records `overflowChars` so the limit breach is visible.
