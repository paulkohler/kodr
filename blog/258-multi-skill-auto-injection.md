# Phase 258: Multi-Skill Auto-Injection — Closing the Gap Phase 257 Left

Phase 257 extracted the SQLite pitfalls from `lang:node` into a standalone
`lang:sqlite` skill. The extraction succeeded: `lang:node` went from 22K chars
to 13K. But it opened a gap. A Node workspace with a SQLite task had been
getting all that pitfall knowledge automatically — it was just part of the
`lang:node` blob. After extraction, the same task got `lang:node` but no
`lang:sqlite` unless the user passed `--skill lang:sqlite` explicitly.

The extraction was correct. The skill was too big to carry. But a feature that
required a manual flag where it used to be automatic is a regression in user
experience, not a win. Phase 258 closes the gap.

## The Scalar Problem

The root cause was a design constraint that had been in place since Phase 122:

```js
const detectedLanguage = isNodeEsm ? 'node' : isRust ? 'rust' : null;
```

One language. Mutually exclusive. `resolveLanguageGuidance` took a string, not a
list, and returned `{ language, source, guidance }` — a single object. Everything
downstream expected that shape.

Widening this to a list required threading the change through four places:

1. `context-packer.mjs` — detection and resolution
2. `context-packer.mjs` — rendering (renderStableSection + renderPromptSections)
3. `src/forensics.mjs` — artifact reading
4. `src/run-pipeline.mjs` — summary recording

## The DRY Problem

There were two SQLite keyword regexes in the codebase. One lived in
`gateLanguageGuidance` in `system-env.mjs` — it gates the `## node:sqlite`
section inside `lang:node` based on the task prompt. After Phase 257, the selection
gate that decides whether to inject `lang:sqlite` at all needed the same regex.

Two copies mean two things can drift. The first time someone added `FTS5` to the
gate (Phase 251), they had to add it to one regex. With two copies, they'd need to
remember both — or find out the hard way when a task with `FTS5` gets `lang:sqlite`
but the `lang:node` sqlite section is suppressed (or vice versa).

The fix was to export the regex once from `system-env.mjs`:

```js
export const SQLITE_TASK_PATTERN =
  /sqlite|DatabaseSync|CREATE TABLE|FTS5|:memory:|node:sqlite/iu;
```

`gateLanguageGuidance` now references `SQLITE_TASK_PATTERN` for its sqlite branch.
`context-packer.mjs` imports the same constant for the selection gate. One regex,
two gates, guaranteed consistency.

## The Widen

The detection logic in `buildWorkspaceContext` became:

```js
const primaryLanguage = isNodeEsm ? 'node' : isRust ? 'rust' : null;
const detectedLanguages = [];
if (primaryLanguage) detectedLanguages.push(primaryLanguage);
if (primaryLanguage && SQLITE_TASK_PATTERN.test(options.taskPrompt || '')) {
  detectedLanguages.push('sqlite');
}
```

`resolveLanguageGuidance` was updated to accept a list (or scalar for back-compat),
discover workspace skill overrides once, and return an array of per-language results.

`renderStableSection` maps each entry through the existing
`renderLanguageGuidanceBlock` and joins with `\n\n`. `renderLanguageGuidanceBlock`
itself was not changed — it still renders one body. The list is a one-level-up
concern.

## The Back-Compat Problem

Tests revealed an issue immediately. Several tests passed `isNodeEsm: true` directly
to `renderPromptSections` without going through `buildWorkspaceContext`. They expected
the ESM block to appear even with no `languageGuidance` array in the context.

The old code extracted `language` from `context?.languageGuidance?.language` — if that
was null, it fell back to `isNodeEsm ? 'node' : null`. The new code had no such
fallback for direct callers.

Fix: when `langEntries` is empty but `isNodeEsm` is true, synthesise a minimal
`{ language: 'node', guidance: undefined, source: 'builtin' }` entry. This keeps
direct-caller tests working and means the `isNodeEsm` parameter in `renderStableSection`
stays meaningful as a last-resort signal rather than dead code.

Two existing context-packer tests also needed updating:
`context.languageGuidance.language` became `context.languageGuidance[0].language`.
These are the only tests that read the internal shape — everything else tests the
system prompt output.

## The Forensics Back-Compat

`forensics.mjs` reads `summary.json` from past runs. Pre-258 runs have the old
scalar form `{ language: 'node', source: 'builtin' }`. Post-258 runs have an array
`[{ language: 'node', source: 'builtin' }, { language: 'sqlite', source: 'builtin' }]`.

The updated `forensics.mjs` handles both:

```js
if (Array.isArray(languageGuidance)) {
  for (const entry of languageGuidance) { ... }
} else if (languageGuidance?.language) {
  // Legacy scalar form (pre-258 summary.json files).
  ...
}
```

## Test Counts

Before: 1964 tests, all passing.
After: 1980 tests, all passing. 16 new tests in `test/system-env.test.mjs`:

- 9 tests for `SQLITE_TASK_PATTERN` (matches/rejects each keyword)
- 7 tests for auto-injection behavior (Node+SQLite, Node-only, Rust+SQLite,
  suppression, non-Node+SQLite)

## The Dogfood Note

The phase file calls for a live dogfood run to confirm both skills appear in the
actual emitted system prompt (not just in unit tests). The live model server is
not available in this implementation session. The unit tests are thorough — they
call `buildWorkspaceContext` end-to-end and assert on the system prompt text
using a unique marker from the `lang:sqlite` body (`BigInt bind`). The `gated
prompt` budget guard tests also confirm sizes stayed below their Phase 257 limits.
A live dogfood would confirm the wire-up in a real LM Studio session; that is the
next validation step.
