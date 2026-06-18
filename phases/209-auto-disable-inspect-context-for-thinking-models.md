# Phase 209 — Auto-disable Inspection Context for Thinking Models

## Goal

Thinking-model runs currently require an explicit `--no-inspect-context` flag to
prevent context-window issues. Phase 205 added `wireNoStream` to
`applyModelProfileDefaults` as the canonical indicator that a model is a
thinking model. This phase wires `inspectContext = false` to that same signal,
so the flag is no longer needed for the common case.

A user who wants to force inspection context on a thinking model can still pass
`--inspect-context` explicitly; `_inspectContextSet` guards against
auto-overriding explicit CLI flags.

## Change

### `src/model-profiles.mjs` — `applyModelProfileDefaults`

After the existing `if (profile.wireNoStream) { next.wireNoStream = true; }` block,
add:

```js
if (profile.wireNoStream && !options._inspectContextSet) {
    next.inspectContext = false;
}
```

### `test/model-profiles.test.mjs` — new test cases

- thinking model without `--inspect-context` flag → `inspectContext` is `false`
- thinking model with explicit `--inspect-context` flag → `inspectContext` stays `true`
- thinking model with explicit `--no-inspect-context` → `inspectContext` stays `false`
- non-thinking model → `inspectContext` is unchanged (`'auto'`)

## Done criteria

- [x] `applyModelProfileDefaults` sets `inspectContext = false` for wireNoStream profiles unless `_inspectContextSet`.
- [x] New unit tests cover all four guard cases.
- [x] Existing tests still pass.
- [x] `npm run format && npm run check` clean.
- [x] `process/decisions.jsonl` entry added.
- [x] Blog post exists.
- [x] Roadmap entry marked done.
- [x] Commit made.
