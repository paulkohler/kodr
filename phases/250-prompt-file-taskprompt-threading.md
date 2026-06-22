# Phase 250: Thread Resolved --prompt-file Text Into workspaceContextOptions

## Goal

Make `--prompt-file` runs derive the same prompt-based context signals as
`-p/--prompt` runs. Today the resolved file text never reaches
`workspaceContextOptions`, so greenfield `.mjs` detection and the lang:node
guidance block silently vanish for every `--prompt-file` invocation.

## The bug

`workspaceContextOptions(options, cwd)` in `src/cli/options.mjs:22` reads:

```js
taskPrompt: options.prompt || '',
```

`options.prompt` is the raw `-p/--prompt` flag value. When the prompt comes from
`--prompt-file`, `options.prompt` is `''` and the actual text lives in the
`rawPrompt` local returned by `loadPrompt()` — which is never handed to
`workspaceContextOptions`. So `taskPrompt` is empty on every `--prompt-file`
run, and in `src/context-packer.mjs`:

- `detectNodeEsm(cwd, files, options.taskPrompt || '')` (line 60) never sees the
  `.mjs`/`.cjs` greenfield cue, so on an empty workspace `isNodeEsm` stays false.
- With `isNodeEsm` false the entire lang:node guidance block is omitted, and
  `gateLanguageGuidance` (`taskContext: options.taskPrompt || ''`) never runs.
- `detectRust(files, options.taskPrompt || '')` (line 67) likewise loses its
  greenfield `.rs` cue.

Confirmed by the kodr-test-operator phase-249 dogfood: `summary.json` showed
`languageGuidance: None`, `isNodeEsm: None`, and a 3633-char system prompt with
no Node/ESM block, on a `--prompt-file` run whose prompt named `.mjs` targets.

## Design

This is a surgical threading fix, not a refactor. Add an optional third
parameter carrying the already-resolved prompt and prefer it over the raw flag.

### 1. `workspaceContextOptions` signature (`src/cli/options.mjs`)

Change line 12 and line 22:

```js
export function workspaceContextOptions(options, cwd, resolvedPrompt) {
    // ...
    taskPrompt: resolvedPrompt ?? options.prompt ?? '',
    // ...
}
```

- Use `??` (not `||`) for `resolvedPrompt` so an explicitly-resolved empty
  prompt string is respected while `undefined` (call sites not yet passing the
  arg) falls through to the existing `options.prompt` behaviour. The trailing
  `?? ''` keeps the never-undefined contract.
- No other field in the returned object changes. Existing callers that pass only
  two args are unaffected (third arg is `undefined`).

### 2. Call sites

All run-pipeline call sites already have the resolved prompt in scope; the
variable name differs by branch.

| File | Line | In-scope resolved prompt | Change |
|------|------|--------------------------|--------|
| `src/run-pipeline.mjs` | 395 | `prompt` (resolved at 217–219 from `rawPrompt` at 212) | add `, prompt` 3rd arg |
| `src/run-pipeline.mjs` | 426 | `prompt` (same) | add `, prompt` 3rd arg |
| `src/run-pipeline.mjs` | 1928 | `prompt` (staged loop; same `prompt`) | add `, prompt` 3rd arg |
| `src/commands/compare.mjs` | 22 | `prompt` (resolved at line 16 via `loadPrompt`) | add `, io.cwd` already present → add `, prompt` 3rd arg |
| `src/commands/eval.mjs` | 37 | (none resolved here) | see note below |
| `src/app.mjs` | 232 | `prompt` (resolved at line 222 via `loadOptionalPrompt`) | add `, prompt` 3rd arg |

For `src/run-pipeline.mjs` use the `prompt` local (already includes the prior
scratchpad suffix when present — that suffix is harmless to detection and is the
text the model actually receives, so it is the correct signal source).

`src/app.mjs:232` is the `--show-context` diagnostic branch; `prompt` is the
`loadOptionalPrompt` result from line 222. Pass it so `--show-context
--prompt-file foo.mjs` mirrors the real run.

#### eval.mjs note

`src/commands/eval.mjs:37` builds a *suite-level* base context (`context`) whose
`systemPrompt` is reused only for **proposal** cases (line 91), where each
case's own `evalCase.prompt` is the task and the suite has no single CLI prompt.
Workspace cases re-derive their own context inside `runWorkspaceCase` via the
real pipeline. There is no single resolved prompt to thread at line 37, and
`options.prompt` is typically unset for an eval run. Leave eval.mjs at the
two-arg call (passes `undefined` → unchanged behaviour). Document this
explicitly so it is not mistaken for a missed call site.

### 3. Why not just resolve inside `workspaceContextOptions`

`workspaceContextOptions` is synchronous and pure over `(options, cwd)`;
`loadPrompt` is async and throws `CliError`. Pushing the file read into this
helper would make it async and couple it to the prompt-loading error path at
every caller. Threading the already-resolved value keeps the helper pure and
keeps each command's single `loadPrompt`/`loadOptionalPrompt` call as the one
place that reads and validates the prompt.

## What Changes In Kodr

- `src/cli/options.mjs`: third optional `resolvedPrompt` param; `taskPrompt`
  prefers it.
- `src/run-pipeline.mjs` (×3), `src/commands/compare.mjs`, `src/app.mjs`: pass
  the in-scope resolved prompt as the third arg.
- `src/commands/eval.mjs`: unchanged, with a one-line comment recording why.

## What Does Not Change

- `-p/--prompt` runs: `resolvedPrompt` equals `options.prompt`, so `taskPrompt`
  is byte-identical to today — that is the regression lock.
- The `workspaceContextOptions` return shape, every other field, and the
  context-packer detection logic are untouched.
- eval suite behaviour.

## Test Requirements

`workspaceContextOptions` currently has **no dedicated unit test** (grep:
nothing in `test/` imports `cli/options.mjs` for it). Add coverage:

1. **Unit (`test/cli-options.test.mjs`, new file):**
   - `workspaceContextOptions({ prompt: '' }, cwd, 'create app.mjs')` →
     `taskPrompt === 'create app.mjs'` (resolved prompt wins over empty flag).
   - `workspaceContextOptions({ prompt: 'flag text' }, cwd)` →
     `taskPrompt === 'flag text'` (two-arg back-compat; no regression).
   - `workspaceContextOptions({ prompt: 'flag text' }, cwd, 'file text')` →
     `taskPrompt === 'file text'` (resolved prompt takes precedence — both
     should never be set in practice, but pin the precedence).
   - `workspaceContextOptions({ prompt: 'flag text' }, cwd, '')` →
     `taskPrompt === ''` (explicit empty resolved prompt respected via `??`).

2. **End-to-end greenfield detection (extend `test/app.test.mjs`):**
   New `--show-context --prompt-file` case modeled on the existing
   `prints workspace context without calling the model` test (~line 2100):
   - Empty/greenfield temp `cwd` (no `.mjs`, no `package.json`).
   - Write a prompt file naming a `.mjs` target, e.g.
     `Create a calculator in calc.mjs with node:test coverage.`
   - Run `['run', '--show-context', '--no-inspect-context', '--prompt-file',
     'task.md', '--base-url', server.baseUrl]`.
   - Assert the printed context contains the Node/ESM guidance (match a stable
     marker from the lang:node builtin block, e.g. `/ESM/u` or the heading the
     renderer emits) — proving `isNodeEsm` fired from the file-resolved prompt.
   - Assert `server.recordings.length === 0` (no model call), matching the
     sibling test.
   - Add a contrast assertion or a sibling negative case: the same greenfield
     run **without** a `.mjs` cue in the prompt does **not** emit the block, so
     the test pins the prompt as the cause rather than the workspace.

   Pick the marker string by reading the rendered lang:node block in
   `src/context-packer.mjs` (`renderLanguageGuidance`/`buildSystemPrompt`) so
   the assertion matches actual output.

3. **No-regression:** the existing `--show-context` and `--prompt-file` tests
   must stay green unchanged.

## Non-Goals

- No change to detection heuristics (`.mjs`/`.cjs`/`.rs` cues, package.json
  type, gate keywords). This phase only delivers the prompt text that those
  heuristics already expect.
- No eval-suite prompt threading.
- No refactor of `workspaceContextOptions` into an async/prompt-loading helper.

## NEXT.md

No new candidate to add. This phase is a found-bug fix surfaced by the phase-249
dogfood, not a NEXT.md promotion, so there is no NEXT.md item to delete. (The
existing NEXT.md candidates — SQLite gate keywords, staged-planning max_tokens,
package.json reminder, capped-retry zero-output, FTS5 trigger conflict — are
unrelated and stay.)

## Done Criteria

- [x] `workspaceContextOptions` accepts `resolvedPrompt` and prefers it via `??`.
- [x] `src/run-pipeline.mjs` (lines 395, 426, 1928), `src/commands/compare.mjs`
      (line 22), and `src/app.mjs` (line 232) pass the in-scope resolved prompt.
- [x] `src/commands/eval.mjs` left two-arg with an explanatory comment.
- [x] New `test/cli-options.test.mjs` unit tests for the precedence matrix.
- [x] `test/app.test.mjs` greenfield `--prompt-file` → Node/ESM block test
      (plus the no-cue negative contrast).
- [x] `npm run format`, tests, `npm run check` all green.
- [x] `process/decisions.jsonl` / `process/failures.jsonl` updated (record the
      silent-absence bug as a failure: prompt-file context-signal loss since the
      `workspaceContextOptions` extraction).
- [x] Blog post capturing the dogfood-discovered prompt-file signal loss.
- [x] roadmap entry checked, NEXT.md unchanged, commit.
