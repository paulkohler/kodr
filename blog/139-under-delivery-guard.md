# Phase 139: Notice When the Model Stops Early

The phase-137 dogfood left an open wound: gpt-oss-20b was asked for three files,
delivered one, and said it was done. `finish_reason: stop`. Status OK. One file
written, two simply absent. After phase 137 fixed the extractor, the delivered
file finally landed — but the harness still couldn't recover the missing ones.

The extractor is good at getting what the model sent. It can't invent what the
model never wrote.

## The signal that was already there

The task prompt said it. Explicitly.

> Create three files:
> - src/store.mjs: ...
> - src/cli.mjs: ...
> - test/store.test.mjs: ...

Three paths, in the text the model received. After extraction, `proposal.files`
had one entry. The other two paths were absent. That's a detectable gap — the
only thing missing was someone checking.

## The guard

After extracting a valid proposal with `finish_reason: stop`, the harness now
extracts path-like tokens from the original prompt via regex. File paths —
`src/store.mjs`, `test/store.test.mjs` — match. Node specifiers like
`node:fs` and version strings like `1.0.2` are excluded.

If any prompt-named path is absent from the delivered proposal, the harness
issues one continuation nudge:

> Your response is missing 2 file(s) mentioned in the task: `src/cli.mjs`,
> `test/store.test.mjs`. Please provide the complete content for each missing
> file now.

The model gets another turn. The additional files are merged into the proposal.
The guard fires at most once — not a loop.

## What it doesn't do

It doesn't fire when:
- The proposal is not status OK (error states are handled elsewhere).
- `finish_reason` is `tool_calls` or `length` (those have their own handling).
- The prompt doesn't name any explicit file paths (no false positives on
  vague tasks like "refactor the auth module").

And it doesn't fix models that simply refuse to produce the missing files — if
the nudge response is also empty, the run continues with whatever was delivered.

## Summary field

When the nudge fires and recovers files, `summary.deliveryNudge` records what
was prompted and what was recovered. Visible in `kodr why` output when the
phase-139 metadata flows through.
