# Phase 215: runStagedPrompt Tool-Channel Draft Fallback

## The failure that prompted this phase

Phase 213 added a pending-write guard to the `run_command` handler. The guard
fires when the model calls `run_command` against files that only exist as pending
writes in `proposalDraft` — not yet on disk. It returns a synthetic error+hint
telling the model to return the JSON proposal envelope instead.

Dogfooding confirmed the guard fired. The model stopped trying to run commands
against the pending files. Then the run failed anyway — `ProposalMissingError`.

The guard fixed one problem and exposed another: the model was now listening
and returning a stop response without a JSON envelope, having already written
all its files via `write_file` tool calls. The harness had the files. The
harness didn't know it.

## Two code paths, one fallback

The main pipeline (line 1072 of `run-pipeline.mjs`) handles this case:

```js
if (draftNonEmpty || (capturedDraft !== null && proposal !== null)) {
    if (draftNonEmpty) {
        proposal = mergeProposalWithDraft(capturedDraft, proposal);
        proposalError = null;
    }
}
```

When `extractProposal(completion.text)` returns null but `proposalDraft` is
non-empty, the main pipeline synthesises a proposal from the captured writes.
This was added in Phase 119 (W3 fallback).

`runStagedPrompt` calls `extractProposal(completion.text)` on each stage
completion. On null, it went directly to `ProposalMissingError`. It never
looked at `completion.proposalDraft`.

The staged path was missing the same fallback the main path had for 96 phases.

## The fix

One block before the `ProposalMissingError` branch in `runStagedPrompt`:

```js
if (!proposal) {
    // W3 fallback (mirrors main pipeline): if tool-channel writes captured
    // the stage's files, synthesise the proposal from the draft.
    const capturedDraft = completion.proposalDraft ?? null;
    if (capturedDraft && !capturedDraft.isEmpty) {
        proposal = mergeProposalWithDraft(capturedDraft, null);
    }
}
if (!proposal) {
    writeError = { ... ProposalMissingError ... };
    break;
}
```

`mergeProposalWithDraft` was already imported — it's used in three other places
in the same file. The staged path just wasn't calling it.

## The secondary fix: bare test-runner slip-through

The Phase 213 guard checks `pendingPaths.some(p => command.includes(p))`. It
matches commands containing a pending-write path substring — `node --test
src/foo.test.mjs` when `src/foo.test.mjs` is pending.

Bare `node --test` (no path argument) slipped through. The test runner discovers
test files itself at runtime. There's no path literal to match against.

Phase 215 adds a `TEST_RUNNER_RE` regex:

```js
const TEST_RUNNER_RE =
    /^(node\s+--test|npm\s+(run\s+)?test|yarn\s+test|pnpm\s+test|pytest|python3?\s+-m\s+unittest|go\s+test|cargo\s+test)\b/u;
```

The guard now fires when either:
- The command contains a pending-write path string (existing check), OR
- The command matches a test-runner pattern AND the draft is non-empty

Both intercept the same failure mode: running tests before writes have landed
on disk.

## Why the staged path was behind

The main pipeline and `runStagedPrompt` evolved on different tracks. Phase 119
added the W3 fallback to the main path when native tool-call mode was first
introduced. `runStagedPrompt` was added later (Phase 105) and took its own
simpler path: plan → extract proposal → apply. The W3 fallback never got
ported because staged mode wasn't initially designed around native tool writes.

Phase 213 started porting native-mode patterns to staged runs (the guard).
Phase 215 completes that port by adding the W3 fallback. The two code paths
now handle the empty-envelope/non-empty-draft case the same way.
