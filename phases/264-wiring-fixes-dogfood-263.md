# Phase 264 — Wiring Fixes from Dogfood (phases 260/261)

Two silent wiring bugs found during the Phase 261–263 dogfood run
(artifact: `~/src/kodr-testing/2026-06-23T10-40-17.105Z`).

## Bug 1 — `suppressThinkingOnRunaway` never forwarded to options

**File:** `src/model-profiles.mjs`, function `applyModelProfileDefaults`

**Symptom:** `healing.mjs` line 416 check `if (options.suppressThinkingOnRunaway === true)`
always sees `undefined`. The Phase 260 runaway-retry branch never fires.

**Root cause:** `applyModelProfileDefaults` copies `wireNoStream` from the profile
into `next` with an explicit block, but has no equivalent block for
`suppressThinkingOnRunaway`. The qwen3.6-35b-a3b built-in profile declares
`suppressThinkingOnRunaway: true`; the flag is silently lost before reaching the
heal loop.

**Fix:** Add a forwarding block analogous to the `wireNoStream` block:
```js
if (profile.suppressThinkingOnRunaway) {
  next.suppressThinkingOnRunaway = true;
}
```

## Bug 2 — `detectNodeEsm` returns false for plain `.js` greenfield tasks

**File:** `src/context-packer.mjs`, function `detectNodeEsm`

**Symptom:** A greenfield workspace where the task prompt names `node:sqlite`,
`node:http`, `node:test`, or another Node built-in module returns `false` from
`detectNodeEsm`. No language guidance loads, no DatabaseSync anchor appears, and
all Node pitfalls are dark.

**Root cause:** `detectNodeEsm` checks for `.mjs`/`.cjs` in the task prompt or
an existing `.mjs` workspace file. A plain `.js`-named task (e.g. "build a tasks
API with server.js") on an empty workspace has none of these signals.

**Fix 1:** Extend `detectNodeEsm` to also fire when the task prompt contains a
`node:` module reference (e.g. `node:sqlite`, `node:http`):
```js
if (/\bnode:[a-z]/u.test(taskPrompt)) return true;
```

**Fix 2:** In `buildWorkspaceContext`, when `SQLITE_TASK_PATTERN` matches the
task prompt but no primary language has been detected yet (i.e. neither
`isNodeEsm` nor `isRust`), set the primary language to `'node'` so lang:sqlite
auto-injection also fires. `node:sqlite` is a Node-only API; a sqlite signal with
no other language indicator is a strong Node greenfield cue.

## Work items

- [x] Create this phase file
- [x] Fix `src/model-profiles.mjs` — add `suppressThinkingOnRunaway` forwarding
- [x] Fix `src/context-packer.mjs` — extend `detectNodeEsm` with `node:` prefix check
- [x] Fix `src/context-packer.mjs` — SQLITE_TASK_PATTERN greenfield node detection
- [x] Add tests in `test/model-profiles.test.mjs`
- [x] Add tests in `test/context-packer.test.mjs`
- [x] `npm run format`, `npm test`, `npm run check` — all green
- [x] `process/failures.jsonl` entries
- [x] Blog post `blog/264-wiring-fixes-dogfood-263.md`
- [x] Roadmap entry checked
- [x] Version bumped to `0.0.264`
- [x] Commit

## Done criteria

- `applyModelProfileDefaults` forwards `suppressThinkingOnRunaway: true` when
  the profile has it set.
- `detectNodeEsm` returns `true` when the task prompt contains `node:sqlite`,
  `node:http`, `node:test`, or any other `node:` built-in reference.
- `buildWorkspaceContext` sets `primaryLanguage = 'node'` when
  `SQLITE_TASK_PATTERN` matches and no Node/Rust signal was otherwise detected.
- Tests cover both fixes.
- All 1995 + new tests pass.
