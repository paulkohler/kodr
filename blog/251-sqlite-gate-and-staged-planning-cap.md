# Phase 251: Two Surgical Fixes from the Phase-248 Dogfood

Phase 248 ran an ambitious `--staged --prompt-file` session building an
expense-tracker API with SQLite FTS5 search. Two independent failures came out
of it. This phase fixes both.

## Failure A: SQLite pitfalls section not injected

The task described an FTS5 virtual table and a `:memory:` database using
abbreviated schema notation like `categories(id INTEGER PRIMARY KEY, name TEXT)`.
The gate in `gateLanguageGuidance` (`/sqlite|DatabaseSync|CREATE TABLE/iu`) never
matched. The model ran the entire session without the SQLite pitfalls section in
its system prompt.

The model still produced valid SQLite code in many places, but it missed the
`createApp(db)` factory injection pattern and the test state reset pitfall — both
of which are guarded by that section. 12 of 22 tests failed.

The gate was correct by its own logic: the task never wrote `sqlite`,
`DatabaseSync`, or `CREATE TABLE`. The problem was that the gate keywords were
too narrow for tasks that describe schemas in SQL shorthand or reference FTS5
by name.

### The fix

```js
// before
gate = /sqlite|DatabaseSync|CREATE TABLE/iu;

// after
gate = /sqlite|DatabaseSync|CREATE TABLE|FTS5|:memory:|node:sqlite/iu;
```

`FTS5` catches virtual table definitions. `:memory:` catches test-oriented DB
setup. `node:sqlite` is nominally redundant (the `sqlite` substring already
matches it) but documents intent explicitly and is harmless.

The docstring was updated to match.

### The regression test

A new case in `test/system-env.test.mjs` exercises the exact phase-248 miss:

```js
it('includes sqlite section for schema notation with FTS5 but no literal sqlite', () => {
    const result = gateLanguageGuidance(
        makeBody(),
        'build categories(id INTEGER PRIMARY KEY, name TEXT) with an FTS5 index',
    );
    assert.match(result, new RegExp(SQLITE_MARKER));
});
```

This assertion fails without the fix and passes after it. Three companion cases
cover FTS5 alone, `:memory:` alone, and `node:sqlite` (the documented keyword).

## Failure B: staged planning call timed out 3x

The same dogfood session ran `--staged --prompt-file`. The planning stage — the
first API call in `runStagedPrompt` — timed out three times at the 600s wall.

The cause: `runStagedPrompt` passed `options` directly to `completeWithToolCalls`
for the planning call, with no `max_tokens`. For qwen3.6-35b-a3b, LM Studio
ignores `max_thinking_tokens` and only honors `max_tokens`. Without a `max_tokens`
bound, the model reasons indefinitely. The planning call only needs to emit a
stage breakdown into scratchpad — it does not need to produce code — but it was
given an unlimited reasoning budget.

Auto-staged runs (keyword detection) don't hit this because they take the
full-system-prompt main-loop path, which is bounded by the per-turn timeout and
agentic sub-turn budget rather than by a single uncapped planning call.

### The fix

```js
// Phase 251: cap the planning request's reasoning. LM Studio ignores
// max_thinking_tokens for qwen3.6 and honors only max_tokens, so an uncapped
// plan call reasons past the 600s timeout (phase-248 dogfood: 3x timeout).
// Reuse the staged-retry cap = max(completionReserve, 8192) — a plan only emits
// a stage breakdown, and the 8192 floor leaves room for a multi-stage plan.
const planCompletion = await completeWithToolCalls(
    { ...options, completionCapMode: 'staged-retry' },
    model,
    ...
);
```

The execute-stage calls at line 1949 and the runaway-retry call at line 1997 are
left unchanged — only the single planning call gets the cap.

`staged-retry` was the right existing mode to reuse. It sets
`max_tokens = max(completionReserve, 8192)`. At qwen3.6's `completionReserve` of
4096, the floor wins and the planning call gets 8192 tokens. That is enough for a
multi-stage plan without risking the 600s reasoning runaway.

A new mode would have added a branch to `applyCompletionCap` with no semantic
difference at this model's profile. Reuse is cleaner.

### The wiring test

The unit tests for `applyCompletionCap` already covered `staged-retry` mechanics.
What was missing was a test that proved `runStagedPrompt` actually passes
`completionCapMode: 'staged-retry'` to the planning call — the wiring fact.

A new describe block in `test/staged-pipeline.test.mjs` drives a full staged run
against the fake server and checks `server.recordings`:

```js
const planRequest = server.recordings.find(
    (r) =>
        r.method === 'POST' &&
        r.url === '/v1/chat/completions' &&
        (r.requestBody?.messages ?? []).some((m) =>
            String(m.content ?? '').includes('Return a plan only'),
        ),
);
assert.ok(planRequest, 'planning request was made');
assert.equal(planRequest.requestBody.max_tokens, 8192);
```

It also asserts the execute-stage request does NOT carry `max_tokens`:

```js
assert.equal(execRequest.requestBody.max_tokens, undefined);
```

This is the guard that a unit test alone cannot provide — it catches the wiring
no-op where `completionCapMode` is set in the wrong options bag or on the wrong
call.

## Test delta

1953 → 1958 tests. 5 new assertions:

- 4 in `test/system-env.test.mjs` (FTS5, `:memory:`, `node:sqlite`, regression)
- 1 in `test/staged-pipeline.test.mjs` (planning cap wiring)
