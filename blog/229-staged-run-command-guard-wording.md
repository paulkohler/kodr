# Phase 229: Staged-Aware run_command / Turn-Exhaustion Guard Wording

Three guards in `src/tool-calls.mjs` were steering the model with the wrong
instructions during staged runs. One of them was making a false factual claim.
This phase closes them out with the same branch pattern proven in Phase 220.

## The three lies (or near-lies)

Phase 220 fixed the repeat-sentinel so that in a staged run it tells the model
to call `write_file` and return `STAGED_DONE`, rather than "Return your final
proposal now." That work identified the sentinel as the highest-urgency offender
but explicitly tracked three other sites as a follow-up.

**Site 1 — Turn-budget-exhausted final-turn message (~line 354):**

```
Turn budget exhausted. Return the final JSON proposal now — do not call any tools.
```

In staged mode there is no final JSON proposal. The model completes a stage by
returning `{"status":"OK","files":[],"messages":[{"level":"info","content":"STAGED_DONE"}]}`.
Telling it to return a proposal envelope when its entire operating model is
write-file-then-STAGED_DONE is the wrong instruction at precisely the moment the
model's budget runs out.

**Site 2 — F1 allowlist-rejection hint (~lines 483 and 497):**

```
The harness has no write tool. Return file changes in the final JSON proposal (files
array), not via shell commands.
```

This is factually false in staged mode. `write_file` and `edit_file` ARE registered
in a staged run — that is the entire point of the staged pipeline. The model has
write tools. Telling it otherwise is not just bad steering; it is wrong information.

**Site 3 — Phase-213 pending-write guard hint (~line 882):**

```
Return the final JSON proposal envelope now. The harness will apply your writes and
run verification automatically.
```

Same problem as site 1: envelope instruction in a staged context.

## The pattern

Phase 220 established the pattern: `const staged = options.inStagedPipeline === true;`
declared in the relevant scope, then a ternary that returns staged wording when true
and byte-identical non-staged wording when false.

The only complication is scope. There is one existing `const staged` in `tool-calls.mjs`
— at line 428, inside the `if (seenToolCalls.has(callKey))` branch of the repeat-sentinel.
It is NOT visible at site 1 (which is before the tool-dispatch loop) or at sites 2
(which are in the sibling `else` branch). Fresh declarations were needed:

- Site 1: declared immediately before the `requestBody = applyResponseFormat(...)` call.
- Sites 2: declared at the top of the `else` block right after `seenToolCalls.set(callKey, 1)`.
- Site 3: declared inside the pending-write guard's `if` block, before the `return`.

## The DRY decision

The F1 hint string at sites 2a and 2b was identical before this change and is identical
after — two occurrences of the same string. AGENTS.md calls for routing shared surfaces
through shared handling. A small module-scope helper eliminates the duplication:

```js
function allowlistWriteHint(staged) {
    return staged
        ? 'Apply file changes via write_file/edit_file tool calls, not shell commands.'
        : 'The harness has no write tool. Return file changes in the final JSON proposal (files array), not via shell commands.';
}
```

Sites 1 and 3 each appear exactly once, so an inline ternary is the right call
there — a helper would add indirection without removing duplication.

## Stability constraints

The `error` field at site 3 was not touched:

```js
error: 'Files have not been applied to disk yet — run_command cannot access pending writes.',
```

Phase-213 tests match `/pending writes/`. Any drift there breaks existing assertions.
Similarly, the `Command is not allowlisted:` prefix at sites 2 is what the dispatch
branch keys on — the `error` field is stable, only `hint` branches.

The repeat-sentinel at lines ~428–451 was deliberately left untouched. It is already
staged-aware and has its own four-test coverage block from Phase 220.

## Tests

Six new tests, two per site:

**Site 1:** `maxTurns: 1` forces a final-turn message. Inspect
`server.recordings[0].requestBody.messages.at(-1)`. Staged: asserts `/write_file/`,
`/STAGED_DONE/`, absence of `final JSON proposal`. Non-staged: asserts
`/Return the final JSON proposal now/`, absence of `write_file`.

**Site 2:** Fake server returns one `finish_reason: 'tool_calls'` response calling
`run_command` with `{"command":"rm -rf /"}` (not allowlisted), then a final stop.
Find the `role: 'tool'` message for `call_rm` in `completion.messages`, `JSON.parse`
it. Staged: error has `/Command is not allowlisted:/`, hint has `/write_file/`, no
"no write tool". Non-staged: hint matches `/The harness has no write tool\./` and
`/final JSON proposal/`.

**Site 3:** Direct-dispatch (no fake server). Seed the draft with `write_file`, then
dispatch `run_command` referencing the pending path. Staged: result.error matches
`/pending writes/`, result.hint matches `/write_file/` and `/STAGED_DONE/`. Non-staged:
hint matches `/Return the final JSON proposal envelope now\./`, no `write_file`, no
`STAGED_DONE`.

All six passed immediately. Existing Phase-213 and Phase-220 tests were unaffected —
the error strings and non-staged wording are byte-identical to before the change.

## Test count: 1822 → 1828

## Postscript: the dogfood caught a wiring no-op the unit tests missed

The six new unit tests passed and a fresh-context review approved the phase. But
the live staged dogfood told a different story: a confirmed staged run
(`staged: true`) fired the pending-write guard (Site 3) six times and handed back
the **envelope** hint ("Return the final JSON proposal envelope now") every time —
never the new staged wording. The fix was a no-op in production.

Root cause: the registry is built in `run-pipeline.mjs` *before*
`shouldUseStagedExecution` is evaluated, and `createBuiltinRegistry` was never
passed `inStagedPipeline`. So the Site-3 guard — which lives inside the registry
handler — always read `options.inStagedPipeline === false`. Sites 1 and 2 live
inside `completeWithToolCalls`, which *does* receive `{ ...options,
inStagedPipeline: true }` per stage, so they worked. The Site-3 unit test passed
because it constructed the registry with `inStagedPipeline: true` **explicitly** —
it proved the registry's branch logic, not that the production caller wires the
flag.

The fix computes `willStage = !parent && shouldUseStagedExecution(options, prompt,
context)` once, before the registry is created, passes it as the registry's
`inStagedPipeline`, and reuses it at the staged branch (one source of truth).
`shouldUseStagedExecution` is now exported with a focused decision test. Re-running
the same staged dogfood on the fixed build: the guard now delivers "Apply file
changes via write_file tool calls" and zero envelope hints.

The lesson — recorded in `process/failures.jsonl` as `229-dogfood` — is sharp: a
unit test that *constructs a dependency with a flag already set* does not prove
the caller passes that flag. Wiring no-ops slip past green unit tests and reviews;
the live run is what exposed it.
