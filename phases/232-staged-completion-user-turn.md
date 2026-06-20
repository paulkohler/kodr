# Phase 232 — Staged Completion: Synthetic User Turn Over Embedded Tool Hint

## Motivation

Phase-223 dogfooding (`process/failures.jsonl` `223-staged-completion`) observed
that embedding the `STAGED_DONE` completion JSON inside a `tool`-role result
message does NOT reliably break qwen3.6's tool-calling loop in staged mode — the
model treats it as ambient state to reason over and keeps calling tools (often
repeating the same call) until the per-stage turn budget exhausts
(`turn_budget_exhausted`). The hypothesis: deliver the completion instruction as
a clean USER-role turn the model must answer.

## Why this is NOT redundant with phases 224/225 auto-advance

Each implementation stage is ONE `completeWithToolCalls` call. The inner
`while (true)` tool loop, the `seenToolCalls` Map, and the repeat-escalation
logic all live INSIDE that call and reset every stage. Phases 224 (auto-advance
on zero new unique writes, needs `safeWriteSteered`) and 225 (auto-advance after
two zero-applied-write stages) act at the OUTER stage level, AFTER a stage has
already burned its whole turn budget looping. The repeat-escalation steer
(`tool-calls.mjs:441-463`) is the only mechanism that can break the loop WITHIN a
stage — and it currently uses a `tool`-role message the model ignores. The
synthetic user turn is the **inner exit** (breaks the loop one stage earlier,
yielding a clean STAGED_DONE); 224/225 remain the **outer safety net**. Strictly
no worse than today in the worst case (model still ignores it → budget exhausts
as before → 224/225 catch it).

## Design decisions

1. **Trigger:** escalation (`count >= ESCALATION_THRESHOLD` = 3) AND
   `options.inStagedPipeline === true`, fired AT MOST ONCE per
   `completeWithToolCalls` call via a `stagedCompletionTurnSent` flag. Key off the
   existing `seenToolCalls` count — do NOT restrict by tool name (an identical
   repeated `write_file` is as stuck as a repeated `run_command`; the write was
   captured on the first call, so repeats are pure spin).
2. **Keep tools available (do NOT drop them).** Mid-budget we cannot know all
   files are written; dropping tools would replicate F1 final-turn forcing
   prematurely and risk truncating legitimate remaining writes. The message
   therefore offers BOTH exits truthfully: write the next file, OR return
   STAGED_DONE. It must NOT assert "all files are written" (unverifiable — and
   phase 229 rejected factually-false guard strings).
3. **Keep the existing tool-role escalation message byte-identical** and ADD the
   user turn AFTER it. The API requires a tool result for the offending
   `tool_call_id`; the user turn is additive (tool result first, then user turn).
4. **Idempotency & ordering:** the user message is appended only AFTER all tool
   results for the turn are pushed (OpenAI requires every assistant `tool_calls`
   to be followed by its tool results before any user message), guarded by the
   fire-once flag — mirrors the `nudgeSent`/`noProposalSteerSent` pattern.
5. **Mutually exclusive with F1 final-turn forcing** by construction: the
   escalation branch lives under `if (!isFinalTurn && finishReason ===
   'tool_calls')` (line 393), and `isFinalTurn` requests drop tools, so escalation
   (and the synthetic-turn injection) cannot run on the final turn. No double user
   message.

## Message text (truthful, dual-exit)

```
You have repeated the same tool call several times without making progress.
Stop calling tools to inspect or verify — verification runs automatically after
all stages complete. If there is another file to create, call write_file for it
now. If every file for this stage is already written, respond with only this JSON
and nothing else:
{"status":"OK","files":[],"messages":[{"level":"info","content":"STAGED_DONE"}]}
```

## File-by-file changes — `src/tool-calls.mjs`

1. Module-scope constant `STAGED_COMPLETION_NUDGE` (the message above), near the
   other steer strings (after `allowlistWriteHint`), with a comment citing the
   phase-223 finding and the truthful dual-exit rationale.
2. `let stagedCompletionTurnSent = false;` near the other idempotency flags
   (~line 317).
3. `let escalatedThisTurn = false;` declared just before the
   `for (const toolCall of toolCalls)` loop (~line 427; resets each turn).
4. In the escalation branch (~line 442, where `count >= ESCALATION_THRESHOLD` &&
   `staged`), add `if (count >= ESCALATION_THRESHOLD && staged &&
   !stagedCompletionTurnSent) { escalatedThisTurn = true; }`. Leave the existing
   `content =` ternary UNTOUCHED.
5. After the `for (const toolCall of toolCalls)` loop closes (between line 509 `}`
   and the `continue;` at 510):
   ```js
   if (escalatedThisTurn && !stagedCompletionTurnSent) {
       stagedCompletionTurnSent = true;
       messages.push({ role: 'user', content: STAGED_COMPLETION_NUDGE });
   }
   ```

No change to `run-pipeline.mjs` (the staged loop already extracts STAGED_DONE
proposals) or `safe-writes.mjs`. No helper file.

## Work items

- [x] Add `STAGED_COMPLETION_NUDGE` constant + comment.
- [x] Add `stagedCompletionTurnSent` flag and per-turn `escalatedThisTurn` local.
- [x] Set `escalatedThisTurn` in the staged escalation branch (existing tool
  message unchanged).
- [x] Inject the user turn after the tool-result for-loop, fire-once.
- [x] Tests in `test/tool-calls.test.mjs` (`describe('staged completion synthetic
  user turn (Phase 232)')`), reusing the Phase 220 `buildServer(repeatCount)`
  helper: (1) staged escalation injects a user turn containing STAGED_DONE +
  write_file + "Stop calling tools", and does NOT claim "All target files are
  written"; (2) fires at most once across 5 repeats; (3) does NOT fire in
  non-staged mode; (4) tools still present on the post-nudge request (verify the
  fake server exposes received requests; else assert a post-nudge tool call was
  still dispatched); (5) regression: normal staged run with no repeats never
  injects it; (6) regression: the existing tool-role escalation message still
  parses to `{ repeat: true, count: 3 }` with "Stop retrying". Confirm the
  existing Phase 220 tests pass unchanged.
- [x] `npm run format`, run tests, `npm run check`.
- [x] `process/decisions.jsonl`: the user-turn-over-tool-message decision (keep
  tools, keep the tool message, fire-once, mutual exclusion with final-turn
  forcing), citing the phase-223 finding and the phase-229 truthfulness
  precedent.
- [x] `process/failures.jsonl`: the phase-223 observation is ALREADY recorded
  (`223-staged-completion`) — do NOT duplicate. (A confirmation entry is added
  after dogfooding.)
- [x] `blog/232-staged-completion-user-turn.md`: "Why a tool result is a whisper
  and a user turn is a tap on the shoulder."
- [x] `roadmap.md`: append `- [x] 232 Staged Completion: Synthetic User Turn Over
  Embedded Tool Hint`.
- [x] `package.json`: bump `0.0.231` → `0.0.232`.
- [x] `NEXT.md`: FIFO-delete the "Staged completion: synthetic user turn" candidate
  block; update frontier note to 232.
- [x] Commit.

## Must NOT change (regression guard)

- Non-staged behavior (injection gated on `staged === true`).
- F1 final-turn forcing (provably mutually exclusive via the `!isFinalTurn`
  guard).
- The existing tool-role escalation message content (byte-identical; Phase 220
  tests guard it).
- `nudgeSent` (E4) / `noProposalSteerSent` (S4) steers.
- W3 proposal-draft (`draftNonEmpty`) handling.
- OpenAI message ordering (user turn only after all tool results for the turn).
