# Phase 258: Multi-skill auto-injection (`lang:node` + `lang:sqlite`)

> **Depends on Phase 257.** Phase 257 extracts the SQLite/FTS5 pitfalls out of
> `lang:node` into a standalone `lang:sqlite` builtin skill
> (`src/builtin-skills/languages/sqlite/SKILL.md`). Phase 258 must not start until
> 257 is committed: the version is `0.0.256` and `src/builtin-skills/languages/`
> currently holds only `node` and `rust`. If `lang:sqlite` does not yet resolve via
> `getBuiltinSkill('lang:sqlite')`, finish 257 first.

## Motivation

Phase 257 made `lang:sqlite` *exist* as a separable skill, but it left the
auto-injection path scalar. Today `src/context-packer.mjs:72` resolves exactly one
language:

```js
const detectedLanguage = isNodeEsm ? 'node' : isRust ? 'rust' : null;
```

That single value flows through `resolveLanguageGuidance` (`:323`) into one
`context.languageGuidance` body, which `renderLanguageGuidanceBlock`
(`src/system-env.mjs:173`) renders. So after 257, a Node workspace with a SQLite
task gets `lang:node` but **not** `lang:sqlite` unless the user passes
`--skill lang:sqlite` by hand. The extraction created a gap: knowledge that used to
auto-inject (because it lived inside `lang:node`) now requires an explicit flag.

Phase 258 closes that gap. It widens the auto-injection path from a scalar language
to a small ordered list, and appends `lang:sqlite` automatically when:

1. a primary language skill was detected (`node` or `rust`), **and**
2. the task context matches the SQLite keyword regex.

This is intentionally minimal: no new discovery mechanism, no config surface, no
generic "secondary skill" framework. It is the scalar→list widen for the one known
secondary skill, wired to the same regex that already gates the SQLite section
inside `lang:node` (`src/system-env.mjs:128`). The explicit `--skill lang:sqlite`
path already composes N skills via `loadSkills` (`src/skills.mjs:291`) and is left
untouched.

## Design

### Selection (context-packer.mjs)

Replace the scalar `detectedLanguage` with an ordered `detectedLanguages` array.
The primary language is the existing `node`/`rust`/`null` choice; `lang:sqlite` is
appended as a secondary when the gate matches.

```js
// Phase 258: primary language is still mutually exclusive (node | rust | null).
const primaryLanguage = isNodeEsm ? 'node' : isRust ? 'rust' : null;
const detectedLanguages = [];
if (primaryLanguage) detectedLanguages.push(primaryLanguage);
// Phase 258: auto-compose lang:sqlite when a primary language is present and the
// task mentions SQLite. Same regex as the lang:node SQLite section gate
// (system-env.mjs gateLanguageGuidance). suppressLanguageGuidance already zeroed
// isNodeEsm/isRust, so primaryLanguage is null and this branch is skipped.
if (primaryLanguage && SQLITE_TASK_PATTERN.test(options.taskPrompt || '')) {
  detectedLanguages.push('sqlite');
}
```

Define the pattern once, exported from `system-env.mjs`, so the selection gate and
the section gate cannot drift:

```js
// system-env.mjs — single source of truth for the SQLite task gate.
export const SQLITE_TASK_PATTERN =
  /sqlite|DatabaseSync|CREATE TABLE|FTS5|:memory:|node:sqlite/iu;
```

Then have `gateLanguageGuidance` reference `SQLITE_TASK_PATTERN` for its `sqlite`
branch instead of re-literalling the regex, and import `SQLITE_TASK_PATTERN` into
`context-packer.mjs`.

### Resolution (`resolveLanguageGuidance`)

Resolve the list to a list. Keep the per-skill resolution (override-vs-builtin)
exactly as it is today; just map over the languages and return an array of the
existing result shape, or `null` when empty:

```js
async function resolveLanguageGuidance(cwd, languages, options = {}) {
  const list = Array.isArray(languages)
    ? languages.filter(Boolean)
    : languages ? [languages] : [];   // back-compat: accept a scalar
  if (list.length === 0) return null;
  const { discoverSkills } = await import('./skills.mjs');
  let discovered = [];
  try {
    discovered = await discoverSkills(cwd, { skillsDirs: options.skillsDirs || [] });
  } catch {
    // Discovery failure must not break prompt assembly — every entry falls back to builtin.
  }
  const resolved = list.map((language) => {
    const override = discovered.find((s) => s.name === `lang:${language}`);
    return override?.body?.trim()
      ? { guidance: override.body, language, source: 'override' }
      : { guidance: undefined, language, source: 'builtin' };
  });
  return resolved; // array of { guidance, language, source }
}
```

`context.languageGuidance` becomes an array of the same per-skill shape it holds
today. Forensics (`src/forensics.mjs:105`) and the run summary
(`src/run-pipeline.mjs:1771`) read `languageGuidance.language` / `.source` on a
single object — update them to map over the array (e.g. join the
`<language> guidance: <source>` detail lines, or emit one detail per entry). The
primary (first) entry preserves the prior single-language behaviour for any
consumer that only wants the head.

### Render (`renderLanguageGuidanceBlock` + call site)

Keep `renderLanguageGuidanceBlock` rendering **one** skill body — it stays
responsible for builtin lookup, override substitution, and (for `node`) running
`gateLanguageGuidance` over its own body. The list is rendered by mapping each
entry through the existing single-body renderer and joining:

```js
// context-packer.mjs renderStableSection — was a single renderLanguageGuidanceBlock call.
const langEntries = Array.isArray(languageGuidance)
  ? languageGuidance
  : languageGuidance ? [languageGuidance] : [];
const langBlocks = langEntries
  .map((entry) =>
    renderLanguageGuidanceBlock({
      guidance: entry.guidance,
      language: entry.language,
      taskContext,
    }),
  )
  .filter(Boolean);
if (langBlocks.length) parts.push(langBlocks.join('\n\n'));
```

This is the minimal-change choice: `lang:sqlite` is gated at *selection* time (it is
only in the list when the SQLite regex matched), so by the time its body reaches
`renderLanguageGuidanceBlock` it is injected whole — no header-splitting. The
`language === 'node'` branch in `renderLanguageGuidanceBlock`
(`src/system-env.mjs:190`) still runs `gateLanguageGuidance` over the `lang:node`
body to trim *its* HTTP/busboy/sqlite-stub sub-sections; that behaviour is
unchanged. `lang:sqlite` has no `language === 'sqlite'` gate branch, so its body
renders in full (correct — it is all on-topic by construction in 257).

`renderStableSection` (`:690`) currently takes `languageGuidance` (a body string)
and `language` (a tag) as separate positional args. Replace those two with a single
`languageGuidance` array param threaded from `renderPromptSections`
(`:496-505`), which already reads `context?.languageGuidance`. Pass the whole
`context.languageGuidance` array down instead of `.guidance` / `.language`.

## Done criteria

- [x] `SQLITE_TASK_PATTERN` exported from `src/system-env.mjs`; `gateLanguageGuidance`'s
  sqlite branch references it (no duplicated literal).
- [x] `detectedLanguage` scalar widened to `detectedLanguages` array in
  `src/context-packer.mjs` (around `:72`).
- [x] Auto-injection logic: when a primary language (`node` or `rust`) is detected
  and `SQLITE_TASK_PATTERN.test(taskPrompt)` matches, `'sqlite'` is appended to
  `detectedLanguages`.
- [x] `resolveLanguageGuidance` (`:323`) accepts the list (back-compatible with a
  scalar), resolves N skills, returns an array of `{ guidance, language, source }`
  or `null` when empty.
- [x] `renderStableSection` (`:690`) and its call site in `renderPromptSections`
  (`:496-505`) thread the array; the body is rendered by mapping each entry through
  the existing single-body `renderLanguageGuidanceBlock` and joining with `\n\n`.
- [x] `renderLanguageGuidanceBlock` (`src/system-env.mjs:173`) is unchanged in
  responsibility (renders one body; still gates `lang:node` via
  `gateLanguageGuidance`) — or minimally adjusted only if the array threading
  forces it.
- [x] `src/forensics.mjs:105` and `src/run-pipeline.mjs:1771` updated to read the
  array shape (map over entries, or take the head) without crashing on the new type.
- [x] `test/system-env.test.mjs`: a Node + SQLite task (prompt contains e.g. `FTS5`
  or `DatabaseSync`) auto-includes `lang:sqlite` guidance in the system prompt; a
  Node-only task (plain HTTP / utility prompt) does **not**.
- [x] `test/system-env.test.mjs`: a Rust + SQLite task auto-includes `lang:sqlite`
  alongside `lang:rust` (proves the secondary is primary-agnostic).
- [x] Existing `gateLanguageGuidance` tests still pass (the sqlite branch now reads
  `SQLITE_TASK_PATTERN`; behaviour identical).
- [x] Existing prompt budget guard tests still pass — with 257 shipped, the
  `lang:node` body is smaller, so the gated/ungated assertions and the auto/native
  char limits still hold (review the post-257 limits; do not loosen them to hide a
  regression).
- [x] `npm run format` clean.
- [x] `node --test` passes.
- [x] `npm run check` passes.
- [x] `process/decisions.jsonl` entry (scalar→list widen; selection-time gate for the
  one known secondary skill; why no generic discovery mechanism yet).
- [x] Blog post for Phase 258.
- [x] Roadmap entry checked: `- [x] 258 Multi-skill auto-injection (lang:node + lang:sqlite)`.
- [x] Version bump to `0.0.258` in `package.json`.
- [x] Commit.

## Implementation notes

- **Keep the render path dumb.** `renderLanguageGuidanceBlock` keeps rendering a
  single body. The list is handled one level up by mapping + joining. Joining with
  `\n\n` matches how `renderStableSection` already joins its `parts`; do **not**
  invent a separator (`---`) the rest of the prompt does not use.
- **Single source of truth for the gate.** The selection-time gate and the
  `lang:node` section gate use the *same* regex
  (`/sqlite|DatabaseSync|CREATE TABLE|FTS5|:memory:|node:sqlite/iu`). Export it once
  (`SQLITE_TASK_PATTERN`) and reference it from both `system-env.mjs` and
  `context-packer.mjs` so a future keyword addition updates both paths at once.
  Note the regex carries the `g`-free flags `iu`; if you ever call `.test()` in a
  loop, the absence of `g` means no `lastIndex` state to reset — safe to share.
- **`lang:sqlite` is gated at selection, not at render.** Because it only enters
  `detectedLanguages` when the task matched, its body is injected whole. There is no
  `language === 'sqlite'` branch in `renderLanguageGuidanceBlock`, and there must not
  be — the skill is all-or-nothing for Phase 258 (whole skill in or out). Per-section
  gating of `lang:sqlite` is explicitly out of scope.
- **Order matters for prompt stability.** Always append `sqlite` *after* the primary
  language so the rendered block order is deterministic (`lang:node` then
  `lang:sqlite`). Prefix stability (phase 87) cares about byte order.
- **Test the gate boundary precisely.** A prompt containing `FTS5` or `DatabaseSync`
  must trigger inclusion; a plain HTTP task (`build an express REST API`) or a plain
  utility task (`add a slugify function`) must not. Assert on a marker string unique
  to the `lang:sqlite` body (pick one from the extracted content, e.g. the import-name
  pitfall text) rather than the word `sqlite`, since `lang:node` may still carry the
  2-line SQLite cross-ref stub from 257.
- **`suppressLanguageGuidance` short-circuits.** When `--no-language-guidance` is set,
  `isNodeEsm`/`isRust` are already forced false (`:61`, `:68`), so `primaryLanguage`
  is `null` and the sqlite branch never runs. Add a test asserting suppression yields
  no language blocks at all (primary or secondary).
- **Back-compat the scalar.** `resolveLanguageGuidance` should accept either a scalar
  or an array so any test or caller passing a single string keeps working during the
  transition; normalise to an array at the top.
- **Do not touch the explicit `--skill` path.** `loadSkills` (`src/skills.mjs:291`)
  already composes N skills. `--skill lang:sqlite` continues to work and is orthogonal
  to auto-injection — a user can still force it on for a Rust task whose prompt does
  not literally name SQLite.
- **Verify the post-257 budget headroom in a dogfood run, not just unit tests.** Per
  the dogfood-catches-wiring-no-ops rule, run `kodr` once against the local model on a
  Node + SQLite task (e.g. under `~/src/kodr-testing/phase-258/`) and confirm the
  system prompt actually carries both `lang:node` and `lang:sqlite` bodies — unit
  tests that set the array do not prove `renderStableSection` wires it into the
  emitted prompt.
