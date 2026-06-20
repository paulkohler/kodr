# Phase 232: Why a Tool Result Is a Whisper and a User Turn Is a Tap on the Shoulder

There is a recurring pattern in qwen3.6's staged behaviour: it reads the tool
result, reasons about it, and then makes the exact same tool call again. Phase 223
tried to break this loop by embedding `STAGED_DONE` JSON inside the escalation
tool-error message — a hint the model could act on without any structural change to
the conversation. Three dogfood runs later, all three ran to `turn_budget_exhausted`.
The model was reading the message. It was ignoring it.

Phase 232 is the fix: when the staged escalation fires, inject a clean
`user`-role message after all the tool results for that turn.

## What the conversation looks like now

Before phase 232, a stuck staged run at escalation looked like this in the
message history:

```
assistant  { tool_calls: [list_files({})] }  (3rd repeat)
tool       {"repeat":true,"count":3,"message":"Stop retrying. Call write_file..."}
```

After phase 232:

```
assistant  { tool_calls: [list_files({})] }  (3rd repeat)
tool       {"repeat":true,"count":3,"message":"Stop retrying. Call write_file..."}
user       You have repeated the same tool call several times without making progress.
           Stop calling tools to inspect or verify...
           If every file for this stage is already written, respond with only this JSON...
```

The difference is role. A `tool` result message is, from the model's perspective,
feedback about what just happened. A `user` message is an instruction the model must
now respond to. The model can treat a tool result as ambient context and continue its
current plan. It cannot treat a user turn as ambient context — a user turn is the
next thing it is answering.

## The whisper/tap distinction

The tool-role escalation message was never wrong. It contained `STAGED_DONE`, the
completion envelope, a write_file reminder. The model read it. And then it kept
going.

This is not a model defect to engineer around — it is how tool results work in the
OpenAI message format. Tool results confirm execution. They do not interrupt the
model's planning chain. The model has already decided on its next action before the
tool result is returned; the result either confirms the plan or forces a rethink, but
a `{"repeat":true}` message is structurally a confirmation (the call ran, here is
what happened), not an interruption.

A user turn is structurally an interruption. The model's job is to answer it.

## The truthfulness constraint

The message text took care:

```
You have repeated the same tool call several times without making progress.
Stop calling tools to inspect or verify — verification runs automatically after
all stages complete. If there is another file to create, call write_file for it
now. If every file for this stage is already written, respond with only this JSON
and nothing else:
{"status":"OK","files":[],"messages":[{"level":"info","content":"STAGED_DONE"}]}
```

The phrase "all files are written" does not appear. Phase 229 established the
precedent: the harness cannot assert file-write completion from inside a live tool
loop without checking disk state, and writing false strings into the conversation
turns a steering mechanism into a lying mechanism. The message is dual-exit: write
the next file, or complete the stage. Both exits are truthful. The model chooses.

## OpenAI message ordering: why placement matters

The OpenAI API requires that every `assistant` message carrying `tool_calls` be
immediately followed by a `tool` message for each call in the batch before any
`user` message arrives. Violating this ordering produces a `400 Bad Request`.

The user turn injection point is therefore non-negotiable: it goes after the
`for (const toolCall of toolCalls)` loop closes, not inside it, not before
any tool result. The check is `escalatedThisTurn && !stagedCompletionTurnSent`,
evaluated after the loop. By the time it runs, all tool results are in `messages`.

## Tools stay available

The post-nudge request still carries the full `tools` array. This was a deliberate
decision and the tests assert it.

Mid-budget, we cannot know whether all files have been written. Dropping tools on
the escalation turn would replicate F1 final-turn forcing — which exists precisely
for the case when the turn budget is truly exhausted and a final answer is the only
legal move. Using it early risks truncating a run where the model still had a
legitimate `write_file` to issue.

The nudge offers both exits. If the model heeds it and returns `STAGED_DONE`, the
stage terminates cleanly. If the model writes another file first and then returns
`STAGED_DONE`, the stage also terminates cleanly. If the model ignores the nudge
entirely, the outer phase-224/225 auto-advance safety net catches the no-progress
case. Strictly no worse than before.

## Fire-once

`stagedCompletionTurnSent` is a module-scope flag (per `completeWithToolCalls` call,
same as `nudgeSent` and `noProposalSteerSent`). The per-turn `escalatedThisTurn`
local resets at the top of each turn's tool loop. The result: the user turn is
injected exactly once per stage call, on the first turn where escalation fires,
regardless of how many more repeated calls follow.

## Mutual exclusion with F1 final-turn forcing

The escalation branch lives under `if (!isFinalTurn && finishReason === 'tool_calls')`.
`isFinalTurn` is true only when the turn budget is at its last turn, and `isFinalTurn`
requests drop tools. Because escalation cannot run with no tools, and because
`isFinalTurn` is false whenever escalation can run, the two mechanisms are
provably disjoint. There is no path that produces a double user message.

## Tests: 1850 → 1856

Six new cases in `test/tool-calls.test.mjs` under
`describe('staged completion synthetic user turn (Phase 232)')`:

- Case 1: staged escalation at count=3 injects a user turn containing `STAGED_DONE`
  and `write_file`; does not falsely claim all files are written.
- Case 2: fires at most once across 5 repeats.
- Case 3: does not fire when `inStagedPipeline` is absent (non-staged mode).
- Case 4: `tools` is a non-empty array on the post-nudge request (stronger assertion:
  the fake server exposes `recordings[i].requestBody`, so we assert `tools` directly
  on the request that follows the nudge injection, not just that a tool call was
  dispatched).
- Case 5: normal staged run with no repeats never injects the nudge.
- Case 6: existing tool-role escalation message still parses to `{ repeat: true,
  count: 3 }` with "Stop retrying" (Phase 220 byte-identical regression guard).

All 1850 pre-existing tests pass unchanged.
