# Phase 213: Staged Pipeline Pending-Write run_command Guard

## The failure pattern

Phase-212 dogfooding ran two Node.js tasks. Both ended with
`stopReason:staged / ProposalMissingError`. The model completed the work
correctly — all `write_file` calls landed, the draft was non-empty — but it
never returned the JSON proposal envelope.

Looking at the run artifacts, the pattern was consistent:

1. Model writes all files via `write_file` tool calls.
2. Model reasoning text says "now I should return the JSON proposal".
3. Model calls `run_command` to verify tests against those files.
4. `run_command` fails (files don't exist on disk yet — they're pending writes).
5. Model tries `run_command` again with slightly different arguments.
6. Tool budget exhausts. `stopReason:staged`. Proposal missing.

The model's own scratchpad diagnosed the situation correctly every time: "these
files aren't on disk yet, I should return the JSON envelope". But the tool-call
continuation mechanism overrides the reasoning. Once the model receives a
tool-result, the next action is another tool call — not a `stop`. The reasoning
is advisory; the tool-result context is directive.

## Root cause

`run_command` runs unconditionally. In proposal mode, the handler has no
awareness of what files exist only as pending writes in `proposalDraft`. It
forwards the command to `runVerification`, which executes against the real
filesystem. The files aren't there. The command fails with a file-not-found
error. The model interprets that as a transient failure and retries.

The fix: intercept at the handler, not at `runVerification`.

## The guard

The `run_command` handler now checks three conditions before forwarding to
`runVerification`:

1. `applyMode === 'proposal'` — guard only makes sense when writes aren't on disk yet
2. `proposalDraft && !proposalDraft.isEmpty` — there are actually pending writes
3. Some pending path appears as a substring of the command string

When all three hold, the handler returns a synthetic object instead of running:

```js
return {
  error: 'Files have not been applied to disk yet — run_command cannot access pending writes.',
  hint: 'Return the final JSON proposal envelope now. The harness will apply your writes and run verification automatically.',
};
```

The `hint` key is deliberate. The model sees it in the tool result and it
repeats the instruction the model's own reasoning had already derived: return
the envelope. This gives the reasoning a second chance to win.

## Path matching

The match is substring-based: `pendingPaths.some(p => command.includes(p))`.

That's intentional coarseness. The command string `node --test test/foo.test.mjs`
contains the pending path `test/foo.test.mjs` as a literal substring. No
parsing, no normalization, no edge cases to worry about. A command like `npm test`
does not contain any specific pending path, so the guard doesn't fire even if the
draft has files — the harness handles `npm test` just fine against applied writes.

The only theoretical false positive: a command that happens to contain a path
string that also appears as a pending write but is unrelated. That's contrived
enough to accept.

## Scope

The guard fires only when all three conditions hold. Negative cases that must
pass through to `runVerification` unchanged:

- `applyMode === 'live'`: writes are applied to disk immediately; the files
  exist; `run_command` should work normally.
- Empty draft: no pending writes; nothing to guard against.
- Command doesn't reference any pending path: the command targets already-applied
  or pre-existing files; let it run.

Four tests cover all four cases exactly.

## Closure availability

`proposalDraft` and `applyMode` are already in scope at the `run_command`
registration site via the `createBuiltinRegistry` closure. No new parameters,
no new exports. The guard slots in as twelve lines around the existing
`runVerification` call.
