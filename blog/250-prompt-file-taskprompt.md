# Phase 250: --prompt-file Silently Dropped Node/ESM Context Signals

## The failure

Every `--prompt-file` run since phase 148 has been generating system prompts without
the Node/ESM guidance block, even when the prompt clearly named `.mjs` targets.

The phase-249 dogfood surfaced it cleanly. A `--prompt-file` run whose task was
"Create a calculator in calc.mjs with node:test coverage" produced a `summary.json`
like this:

```json
{
  "isNodeEsm": null,
  "languageGuidance": null,
  "systemPromptChars": 3633
}
```

A comparable `-p` run with the same text would have produced `isNodeEsm: true` and a
system prompt several hundred characters longer, containing the full Node/ESM contract
block. The `--prompt-file` run got none of it.

## The root cause

`workspaceContextOptions(options, cwd)` in `src/cli/options.mjs` sets:

```js
taskPrompt: options.prompt || '',
```

`options.prompt` is the raw `-p/--prompt` flag value. For `--prompt-file` runs,
`options.prompt` is always `''` — the actual text lives in the resolved local from
`loadPrompt()`. That local was never passed to `workspaceContextOptions`.

So on every `--prompt-file` run:

- `detectNodeEsm(cwd, files, options.taskPrompt || '')` received an empty string as
  the task prompt, never seeing the `.mjs`/`.cjs` greenfield cue.
- On a greenfield workspace with no `.mjs` files on disk, `isNodeEsm` stayed `false`.
- With `isNodeEsm` false, `renderLanguageGuidanceBlock` returned `''` and the entire
  Node/ESM contract block was omitted from the system prompt.
- `gateLanguageGuidance` also received the empty `taskContext`, so the SQLite/HTTP
  skill sections were never gated (they were simply absent).
- Same for `detectRust` — the `.rs` greenfield cue was also lost.

The bug was introduced when `workspaceContextOptions` was extracted from `app.mjs`
in phase 148. Before extraction, the resolved prompt was always in scope at the call
site. After extraction, callers passed `(options, cwd)` and the resolved prompt was
silently absent.

## Why it went undetected

The existing `--show-context` tests used `-p` (inline prompt) so `options.prompt`
was always the right value. The `--prompt-file` tests confirmed file loading worked
but never checked the system prompt for ESM guidance. Integration tests that ran a
full model call with `--prompt-file` would generate correct output regardless —
even without the ESM guidance, a capable model writes valid ESM. The signal absence
only shows up in the summary metadata and in subtle model quality differences on
weaker models.

## The fix

One optional third parameter:

```js
export function workspaceContextOptions(options, cwd, resolvedPrompt) {
    return {
        // ...
        taskPrompt: resolvedPrompt ?? options.prompt ?? '',
        // ...
    };
}
```

`??` (not `||`) so an explicitly-resolved empty string is respected while `undefined`
falls through to the existing `options.prompt` behaviour. All two-arg callers remain
unaffected.

The five call sites that already had the resolved prompt in scope now pass it:

| File | In-scope variable |
|------|-------------------|
| `src/run-pipeline.mjs` (×3) | `prompt` (resolved at line ~217 from `rawPrompt`) |
| `src/commands/compare.mjs` | `prompt` (resolved at line 16 via `loadPrompt`) |
| `src/app.mjs` | `prompt` (resolved via `loadOptionalPrompt`) |

`src/commands/eval.mjs` is intentionally left at two args: it builds a suite-level
base context for proposal cases only, with no single CLI prompt to thread. A comment
records this explicitly so the call site is not mistaken for an omission.

## The tests

The regression lock: a new unit test file `test/cli-options.test.mjs` pins the
four-case precedence matrix — resolved prompt wins over empty flag, two-arg back-compat
holds, resolved prompt wins when both are set, and explicit empty string is respected
via `??`.

The end-to-end proof: two new cases in `test/app.test.mjs` using `--show-context
--prompt-file`. A greenfield workspace (no `.mjs` on disk) with a prompt naming
`calc.mjs` asserts `result.context.isNodeEsm === true` and that the system prompt
matches `/Node\.js \/ ESM Contract/u`. A sibling case with no `.mjs` cue asserts
`isNodeEsm === false` and no ESM block — pinning the prompt as the cause rather than
the workspace state.

Both tests assert `server.recordings.length === 0`, confirming no model call fires.

## The lesson

Prompt-loading and context-building were coupled before phase 148. The extraction
decoupled them correctly — the helper is rightly synchronous and pure — but the call
sites needed to bridge the gap by passing the resolved prompt through. The `--prompt-file`
path made this invisible because the flag diverges from the resolved text before
it reaches the context layer.

Any time a helper derives a signal from `options.X` and there's also a `loadX()` that
resolves `options.X` into something richer, check whether every caller threads the
resolved value through, not just the raw flag.
