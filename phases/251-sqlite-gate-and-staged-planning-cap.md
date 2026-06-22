# Phase 251: SQLite gate keywords + staged planning max_tokens cap

## Goal

Two surgical fixes, both surfaced by the phase-248 ambitious dogfood, in two
files:

- **A.** `gateLanguageGuidance` in `src/system-env.mjs` misses SQLite tasks that
  describe a schema without the literal words `sqlite`, `DatabaseSync`, or
  `CREATE TABLE`. Add `FTS5`, `:memory:`, and `node:sqlite` to the gate so
  schema-notation tasks (`categories(id INTEGER PRIMARY KEY, ...)` + an FTS5
  virtual table + a `:memory:` DB) still pull the SQLite pitfalls section.
- **B.** The staged pipeline's **planning** API call in `runStagedPrompt`
  (`src/run-pipeline.mjs`) sends no `max_tokens`. For qwen3.6-35b-a3b, LM Studio
  ignores `max_thinking_tokens` and honors only `max_tokens` (probe 2026-06-20).
  Uncapped, the planning stage reasons past the 600s timeout — it timed out 3×
  on `--staged --prompt-file` in the dogfood. Bound the planning request with a
  `max_tokens` cap.

## Motivation

Phase-248 ambitious dogfood (`--staged --prompt-file`, qwen3.6-35b-a3b):

1. The task carried an FTS5 virtual table and a `:memory:` schema written as
   `categories(id INTEGER PRIMARY KEY, ...)`. The header gate
   `/sqlite|DatabaseSync|CREATE TABLE/iu` never matched, so the model ran without
   the SQLite pitfalls it needed.
2. The planning stage timed out 3× at 600s. `runStagedPrompt`'s plan call
   (run-pipeline.mjs:1897) passes the bare `options` bag, so `applyCompletionCap`
   (model-client.mjs:177) adds no cap — the thinking model reasons indefinitely.
   Auto-staged (keyword-detected) runs avoid this because they take the
   full-system-prompt main-loop path, which is bounded by the per-turn timeout
   and agentic sub-turn budget rather than by a runaway single planning call.

## Design

### Part A — SQLite gate keyword refinement (`src/system-env.mjs`)

In `gateLanguageGuidance`, line 127, replace:

```js
gate = /sqlite|DatabaseSync|CREATE TABLE/iu;
```

with:

```js
gate = /sqlite|DatabaseSync|CREATE TABLE|FTS5|:memory:|node:sqlite/iu;
```

Notes:
- `node:sqlite` is redundant with the existing `sqlite` alternative (the `sqlite`
  substring already matches `node:sqlite`), but is listed explicitly to match the
  item-A spec verbatim and to document intent; it is harmless.
- The new alternatives are all case-insensitive (`/iu` flag), so `fts5`, `Fts5`,
  `:MEMORY:` etc. also match.
- Also update the docstring above the function (system-env.mjs ~line 104) so the
  documented gate pattern stays in sync:
  ```
  *   "sqlite" → include if taskContext matches
  *              /sqlite|DatabaseSync|CREATE TABLE|FTS5|:memory:|node:sqlite/i
  ```

No other behaviour changes: empty/falsy `taskContext` still returns the full
body; HTTP and busboy gates are untouched; non-gated sections still always
include.

### Part B — Staged planning request max_tokens cap (`src/run-pipeline.mjs`)

**Where the planning call is made:** `runStagedPrompt`, the `planCompletion`
call at **run-pipeline.mjs:1897–1903**:

```js
const planCompletion = await completeWithToolCalls(
    options,
    model,
    `${prompt}\n\n## Kodr staged execution\nReturn a plan only. ...`,
    context.systemPrompt,
    registry,
);
```

**The cap mechanism already exists.** `applyCompletionCap` in
`src/model-client.mjs` (lines 177–220) injects a honored `max_tokens` wire cap
when `options.completionCapMode` is `'heal'` or `'staged-retry'`:
- `'heal'` → `max_tokens = completionReserve` (tight, intentional fast-fail).
- `'staged-retry'` → `max_tokens = max(completionReserve, 8192)` (floored so a
  large file generate is not starved).

The cap is applied via `buildChatRequestBody` and respects a caller override
(if the body already pins `max_tokens`/`max_completion_tokens` it is left alone).
A non-positive/unset `completionReserve` yields no cap.

**Profile fields available** (`src/model-profiles.mjs`): the resolved options bag
carries `options.completionReserve` (set by `applyModelProfileDefaults`,
model-profiles.mjs:165–167; `8192` for OpenRouter, `4096` for qwen3.6 local). The
staged runaway-detection code at run-pipeline.mjs:1973–1979 already reads
`options.completionReserve` directly, so it is reliably present on the bag that
reaches `runStagedPrompt`.

**Chosen cap value:** reuse the `staged-retry` semantics — `max(completionReserve,
8192)`. A planning request only needs to emit a stage breakdown into scratchpad,
not full code, but the 8192 floor guarantees room for a multi-stage plan on
profiles with a small `completionReserve` (qwen3.6 = 4096) while still hard-
bounding the reasoning runaway that caused the 600s timeouts. This matches the
already-validated phase-240 floor and avoids inventing a third cap value.

**Implementation:** pass a cap-marked options bag to the planning call only.
Change run-pipeline.mjs:1897–1903 to:

```js
const planCompletion = await completeWithToolCalls(
    { ...options, completionCapMode: 'staged-retry' },
    model,
    `${prompt}\n\n## Kodr staged execution\nReturn a plan only. Do not include files or patches. Put a concise implementation plan in scratchpad, grouped into small stages of at most ${maxStageWrites} files each.`,
    context.systemPrompt,
    registry,
);
```

Add a short comment above the call explaining the cap (cite phase 251 and the
LM-Studio-honors-only-max_tokens probe), e.g.:

```js
// Phase 251: cap the planning request's reasoning. LM Studio ignores
// max_thinking_tokens for qwen3.6 and honors only max_tokens, so an uncapped
// plan call reasons past the 600s timeout (phase-248 dogfood: 3× timeout).
// Reuse the staged-retry cap = max(completionReserve, 8192) — a plan only emits
// a stage breakdown, and the 8192 floor leaves room for a multi-stage plan.
```

Rationale for reusing `'staged-retry'` rather than a new mode:
- The execution-stage calls (run-pipeline.mjs:1949) and their runaway retry
  (1997) keep their existing behaviour — only the single plan call is changed.
- No change to `applyCompletionCap`; no new cap constant to keep in sync.
- The `'staged-retry'` floor is already validated and tested.

If review prefers a distinct planning cap value later, the seam is a one-line
swap of `completionCapMode` plus a new branch in `applyCompletionCap`; not needed
for this fix.

## Test changes

### A. Gate change — `test/system-env.test.mjs`

In the `describe('gateLanguageGuidance', ...)` block (starts line 526), add
cases proving the new keywords fire the SQLite gate (reusing the existing
`makeBody()` helper and `SQLITE_MARKER = 'node:sqlite pitfalls'`):

- `it('includes sqlite section when task mentions FTS5', ...)` — taskContext
  `'add an FTS5 virtual table for search'` → `assert.match(result,
  new RegExp(SQLITE_MARKER))`.
- `it('includes sqlite section when task mentions :memory:', ...)` — taskContext
  `'open a :memory: database for the test'` → match.
- `it('includes sqlite section when task mentions node:sqlite', ...)` —
  taskContext `'import DatabaseSync from node:sqlite'` (this already matches via
  the `sqlite` substring, but asserts the documented keyword) → match.
- `it('includes sqlite section for schema notation with FTS5 but no literal sqlite', ...)`
  — the regression case: taskContext
  `'build categories(id INTEGER PRIMARY KEY, name TEXT) with an FTS5 index'`
  (no `sqlite`/`DatabaseSync`/`CREATE TABLE`) → match. This is the phase-248
  miss; without the new keywords this is the failing assertion.
- Negative guard unchanged: the existing
  `'excludes sqlite section for a non-database task'` (string-utils) must still
  pass — confirm the new alternatives do not over-match a plain task.

### B. Planning cap — `test/model-client.test.mjs` and/or `test/staged-pipeline.test.mjs`

Two layers:

1. **Unit (mechanism) — `test/model-client.test.mjs`:** the `'staged-retry'`
   cap behaviour is already covered (lines 283–321: floor at 8192, uses
   `completionReserve` when it exceeds 8192, defaults to 8192 when unset, caller
   override wins). No new `applyCompletionCap` test is needed — the planning call
   reuses that exact mode. Add a one-line comment near those cases noting that
   the staged **planning** call (run-pipeline.mjs) now also sets
   `completionCapMode: 'staged-retry'`, so the wiring is exercised by the staged
   pipeline test below.

2. **Wiring (the load-bearing assertion) — `test/staged-pipeline.test.mjs`:** add
   a test that runs a staged prompt against the fake model server and asserts the
   **planning request carries `max_tokens`**. The fake server records every
   request body in `server.recordings` (`requestBody` is the parsed JSON). The
   planning request is the FIRST `/v1/chat/completions` POST whose user message
   contains `Kodr staged execution\nReturn a plan only`. Pattern:

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

   Use a profile/options bag where `completionReserve` is the qwen3.6 default
   (4096) so the asserted cap is the 8192 floor, matching the staged-retry rule.
   Follow the existing staged-test harness (drive `main`/`handleChannelRequest`
   with `--staged`, queue a plan response then a STAGED_DONE response). This is
   the dogfood/wiring guard that proves `runStagedPrompt` actually sets the
   marker — a model-client unit test alone would not (per the
   dogfood-catches-wiring-no-ops memory).

## Done criteria

- [x] `gateLanguageGuidance` gate updated to
      `/sqlite|DatabaseSync|CREATE TABLE|FTS5|:memory:|node:sqlite/iu`; docstring
      updated to match.
- [x] SQLite section now included for FTS5 / `:memory:` / `node:sqlite` tasks and
      for the schema-notation regression case; non-database task still excluded.
- [x] `runStagedPrompt` planning call passes
      `{ ...options, completionCapMode: 'staged-retry' }` with a phase-251 comment;
      execution-stage and retry calls unchanged.
- [x] Staged-pipeline wiring test asserts the planning request carries
      `max_tokens = max(completionReserve, 8192)` (8192 at the qwen3.6 default).
- [x] `npm run format`, tests, and `npm run check` clean.
- [x] `process/decisions.jsonl` records the reuse of `staged-retry` for planning
      (and why not a new mode); `process/failures.jsonl` records the phase-248
      gate-miss and planning-timeout symptoms if not already captured.
- [x] Blog post for phase 251 added/updated.
- [x] Both NEXT.md items deleted on ship (see below).

## NEXT.md items to delete on ship

Remove both candidates from `NEXT.md`:

1. **"SQLite skill gate: add FTS5 and :memory: as gate keywords"** (the gate
   refinement — shipped by Part A).
2. **"Staged planning request needs max_tokens for thinking models"** (the
   planning cap — shipped by Part B).

Also update the `## Current frontier` paragraph to note phase 251
(SQLite-gate keyword refinement + staged planning max_tokens cap).
