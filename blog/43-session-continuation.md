# Phase 43: Session Continuation

Phases 42 and 43 are a two-part story: 42 wrote the transcript, 43 uses it.
Every run now produces `conversation.json` (the complete message array ending
with the assistant's reply) and `.kodr/last-run` (a pointer to the most recent
run dir). Phase 43 adds two flags that pick those up:

```
kodr run -p "yes, do that" --continue
kodr run -p "yes, do that" --session 2026-05-29T10-00-00.000Z
```

`--continue` reads `.kodr/last-run`. `--session <id>` uses the run dir basename
directly. Both load `conversation.json` from that dir, append the new user turn,
and hand the full history to the completion function. The model sees its own prior
answer as context, exactly as if it were a real chat session.

## The frozen system prompt (option A)

The original system prompt lives inside `conversation.json` as the first message.
On continuation we use it verbatim — we never rebuild the workspace context.
Rebuilding would be "more correct" when `--yes` already applied changes to files,
but it would double-feed the file map (the model sees both the old context in the
history and a new version prepended), and grows the token count faster each turn.
Freezing is cheaper, deterministic, and correct for the main use case
(`"yes, do that"` follow-ups rarely need updated file context).

## How the chain links

Each continuation run inherits the parent's `sessionId` and records
`parentRunDir`. Fresh runs set `sessionId` to their own basename and
`parentRunDir` to null:

```
fresh run A:        sessionId=A, parentRunDir=null
 → continue to B:  sessionId=A, parentRunDir=<A>
   → continue to C: sessionId=A, parentRunDir=<B>
```

All three run dirs are browsable in `.kodr/runs/`, linked by the parent chain.
Phase 44 (optional) will add `kodr session list` / `kodr session show` to
traverse these chains from the CLI.

## Implementation notes

`completeWithContinuations` and `completeWithToolCalls` both accept an optional
`{ initialMessages }` option. When provided, the pre-built message array is used
directly instead of constructing `[system, user]`. This keeps a single signature
and is backward-compatible with all existing call sites (eval, compare, probe).

The resolver (`resolveParentSession`) throws a descriptive `CliError` for any
bad session — missing `.kodr/last-run`, unknown session id, pre-phase-42 run dirs
without a `conversation.json`. It never silently falls back to a fresh run, which
would confuse the user who expected history to be carried.

A stderr warning is emitted if a continuation uses a different `--model` than
the parent (cross-model sessions are allowed; the warning exists for debugging).

## What this looks like in practice

```
$ kodr run -p "Write a greet.mjs module that says hello" --out session-1
Run ok — finish_stop
Model: qwen/qwen3.6-35b-a3b
...
Proposal: OK — 1 file(s), dry-run (no changes written)
  create greet.mjs
Re-run with --yes to apply these changes.

$ kodr run -p "Also add a farewell function" --continue --out session-2
Run ok — finish_stop
Model: qwen/qwen3.6-35b-a3b
...
Proposal: OK — 1 file(s), dry-run (no changes written)
  create greet.mjs
```

The second run's proposal includes both functions because the model saw the first
turn in its history. Without `--continue` it would have produced just the
farewell function.
