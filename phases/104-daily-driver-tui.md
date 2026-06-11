# Phase 104: Daily-Driver TUI Session

## Goal

Make `kodr` (no arguments, in a configured project) a pleasant daily-driver
terminal UI by adding four quality-of-life features within the existing
zero-dependency, line-oriented constraint.

## Changes

### 1. Colored In-TUI Diff Rendering (`src/tui.mjs`)

New export `renderColoredDiff(writes, view)`:
- Iterates each write's `.diff` field
- Colors by line prefix: `---`/`+++` bold, `@@` cyan, `+` green, `-` red,
  context lines plain
- Called from `renderPendingReview()` so colored diffs appear automatically
  after dry-run turns and on `/review`

Added `cyanText(text)` to `createTuiView` to expose raw cyan styling for diff
hunk headers without prepending the `assistant>` label.

### 2. `@file` References in Prompts (`src/tui.mjs`)

New export `expandFileReferences(text, cwd)`:
- Pattern `@[A-Za-z0-9._/-]+\.[A-Za-z0-9]+` finds all file refs
- Reads each file from `cwd`; silently skips missing paths
- Deduplicates repeated refs
- Prepends context blocks: `## @filepath\n\`\`\`\n<content>\n\`\`\`\n`
- Returns `{expandedPrompt, files: [{path, chars}]}`

`handleTuiLine` calls `expandFileReferences` before building turn options and
shows `assistant> attached: file.js (N chars), ...` when files are inlined.

### 3. Visible Footer Line (`src/tui.mjs`)

New export `renderFooter(state, result, view)`:
- One dim/gray line: `[model=…] [session=…] [review pending] [tokens prompt=… completion=… total=…]`
- Token section omitted when `result.usage` is absent
- `[review pending]` section omitted when no pending review
- Shown after every turn result
- `/status` also appends the footer

### 4. `/retry` Command (`src/tui.mjs`)

- `lastPrompt` added to TUI state; stored after each completed turn
- `/retry` — re-runs the last prompt with current settings
- `/retry --model <id>` — re-runs with a temporary model override; original
  model restored after the retry completes
- Warns (`no previous prompt to retry`) when `lastPrompt` is empty
- Added to `/help` output

## Done criteria

- [x] `renderColoredDiff` exported; colors `---`/`+++` bold, `@@` cyan, `+` green, `-` red
- [x] `cyanText` added to `createTuiView`
- [x] `renderPendingReview` shows colored diffs when `.diff` fields are present
- [x] `expandFileReferences` exported; inlines files, skips missing, deduplicates
- [x] `handleTuiLine` expands `@refs` and shows attached-file note
- [x] `renderFooter` exported; shows model, session, review indicator, token counts
- [x] Footer shown after each turn and on `/status`
- [x] `/retry` re-runs last prompt
- [x] `/retry --model <id>` uses temporary model override
- [x] `/retry` warns when no previous prompt exists
- [x] `/retry` listed in `/help`
- [x] 10 new tests covering all four features (36 total, all pass)
- [x] `npm run check` clean
- [x] `package.json` version bumped to 0.0.104
