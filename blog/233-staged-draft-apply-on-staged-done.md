# Phase 233: The Bug the Safety Net Created

Phase 232 added a synthetic user-turn nudge to break staged tool loops: when the
model repeats the same tool call three times, a `user`-role message fires, offering
a dual exit — write the next file, or return `STAGED_DONE`. The final-audit dogfood
confirmed it worked. The model received the nudge in stage implement-2, and on the
very next turn returned:

```json
{"status":"OK","files":[],"messages":[{"level":"info","content":"STAGED_DONE"}]}
```

Phase 232 validated. Run completed. Test suite... failed.

`server.test.mjs` was not on disk.

## What the model actually did

The model had called `write_file(server.test.mjs, 10202 bytes)` before returning
`STAGED_DONE`. The `write_file` call was dispatched, the tool result was sent back,
the harness captured the pending write in `proposalDraft`. Then — after the phase-232
nudge — the model returned the `STAGED_DONE` envelope with `files:[]`.

The harness received the final stop turn. `extractProposal` parsed the envelope
successfully. `proposal` was non-null. Then the staged loop reached its paths check:

```js
const paths = proposalPaths(proposal); // []
if (paths.length === 0) {
  done = stageMessages.some(m => m.content?.includes('STAGED_DONE')); // true
  ...
  if (done) { break; }
}
```

`done = true`. `break`. Stage finished. `server.test.mjs`: never written.

## Where the bug lived

The staged loop had a W3 fallback added in phase 215:

```js
lastProposal = proposal;
if (!proposal) {
  const capturedDraft = completion.proposalDraft ?? null;
  if (capturedDraft && !capturedDraft.isEmpty) {
    proposal = mergeProposalWithDraft(capturedDraft, null);
  }
}
```

This says: if the model returned no JSON envelope, synthesize a proposal from the
draft. Correct. But the STAGED_DONE response *is* a valid JSON envelope. `proposal`
was non-null. The `if (!proposal)` guard was false. The draft was ignored.

The main (non-staged) pipeline already handled this correctly — W4, added much
earlier, merges the draft into *any* proposal, not just a null one:

```js
if (draftNonEmpty) {
  proposal = mergeProposalWithDraft(capturedDraft, proposal);
}
```

The `mergeProposalWithDraft(draft, envelope)` semantics: captured files go in first,
envelope files overwrite per path, patches concatenate, status/messages/scratchpad
come from the envelope. An empty envelope (`files:[]`) with a non-empty draft
produces the draft's files with the envelope's STAGED_DONE message intact. That is
exactly what was needed.

The staged path just never got the W4 upgrade.

## How phase 232 worsened it

Before phase 232, the stuck tool loop would burn through its sub-turn budget and
eventually return a final envelope via F1 final-turn forcing — with `files:[]` if
the model had already written everything via tool calls, but usually with an attempt
at the draft in the envelope. The draft was still ignored, but the model often
recovered by repeating the file write in a later stage.

Phase 232's nudge steered the model to return `STAGED_DONE` *immediately after the
write_file call*, before a next stage could apply the pending write. Faster
termination, correct STAGED_DONE signal, zero writes applied. The safety net created
the failure mode.

## The fix

Four edits to `runStagedPrompt` in `src/run-pipeline.mjs`:

**1. W4-parity merge** — hoist `capturedDraft`/`draftNonEmpty` out of the
`if (!proposal)` guard and add an `else if` branch:

```js
const capturedDraft = completion.proposalDraft ?? null;
const draftNonEmpty = capturedDraft !== null && !capturedDraft.isEmpty;
if (!proposal) {
  if (draftNonEmpty) {
    proposal = mergeProposalWithDraft(capturedDraft, null);
  }
} else if (draftNonEmpty) {
  proposal = mergeProposalWithDraft(capturedDraft, proposal);
}
lastProposal = proposal;
```

The W3 path (null envelope) is byte-identical in behavior; only the non-null case
gains a merge.

**2. Capture `stagedDoneSignal` before the paths check** — after the W4 merge, the
merged proposal will have paths (the draft's file), so `paths.length === 0` will be
false and the existing STAGED_DONE detection in that branch will not run. Hoist it:

```js
const stagedDoneSignal = stageMessages.some(m => m.content?.includes('STAGED_DONE'));
```

**3. Apply-then-done** — after the successful-apply bookkeeping (`allWrites.push`,
`clearFiles`, `noProgressTurns=0`, stageRecord push), check the hoisted signal:

```js
if (stagedDoneSignal) {
  done = true;
  break;
}
```

No second stageRecord. The write was recorded; the STAGED_DONE is honored; one clean
record, one clean exit.

**4. Zero-applied + STAGED_DONE short-circuit** — in the phase-225 zero-write
branch, if the merged proposal's writes all no-op but the model signaled STAGED_DONE,
complete cleanly rather than treating as no-progress:

```js
if (writeResult.writes.length === 0) {
  if (stagedDoneSignal) {
    done = true;
    stageRecords.push({ done, name: `implement-${stageIndex}`, ... });
    break;
  }
  // ...phase-225 two-consecutive-zero auto-advance unchanged...
```

## What the merge preserves

`mergeProposalWithDraft(draft, envelope)` with `files:[]` in the envelope and a
non-empty draft: the draft file goes into `fileMap` first, no envelope file
overwrites it, `mergedFiles` has exactly the draft file. The STAGED_DONE message
stays on the merged proposal (taken from `envelopeProposal.messages`). Status is
`OK` from the envelope. One write, one done.

If both draft and envelope list the same path, the envelope wins — the model's final
word is preserved. If the envelope lists additional new paths, those are included.
The union is applied as a single `allWrites.push`, no double-count.

## Tests: 1856 → 1859

Three new cases in `test/app.test.mjs` under
`describe('Phase 233 — staged W4-parity: apply pending draft writes on STAGED_DONE')`:

- **(a) THE BUG** — `write_file` turn (tool_calls) followed by STAGED_DONE envelope
  (stop): `server.test.mjs` IS applied to disk, `writeCount >= 1`, stage done. This
  is the regression-proof; without the fix it produces `writeCount:0` and the file
  is absent.
- **(b) Regression** — pure STAGED_DONE envelope with no draft writes: `done`, zero
  `writeCount`. The existing empty-paths branch is unaffected.
- **(c) Union** — draft file + envelope with the same path plus a second file:
  envelope wins on the overlapping path (version:2 not version:1), both files
  written, no double-count.
- **(d) Dropped** — no-op byte-identical write. `prepareChanges` with `apply:true`
  always writes regardless of content change; the zero-write path requires a patch
  with an absent search string. The harness cannot produce a zero-write from a
  full-file write with any content, so this case cannot be exercised in the
  integration harness. Noted in the test file.

All 1856 pre-existing tests (including all phase 215/216/221/224/225/226 staged
tests) pass unchanged.
