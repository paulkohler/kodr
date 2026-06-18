# Phase 204: ANSI-Aware String Truncation Utility

## Motivation

The issue-tracker example's `formatTable` truncated cells by raw `.length`,
clipping mid-ANSI-escape-sequence when a cell contained coloured text (e.g.
status badges). The resulting output had visible garbage: partial `\x1B[` or
`m` characters appearing in the table.

The fix is straightforward: measure visible width (strip ANSI codes first) and
walk character-by-character when truncating (preserving escape sequences that
precede the cut point, dropping those that follow it).

## What this phase does

`src/ansi-utils.mjs`:
- `visibleWidth(str)` — strips CSI escape sequences (`/\x1B\[[0-9;]*[A-Za-z]/g`)
  and returns `str.length` of the remainder.
- `truncateVisible(str, width, ellipsis='')` — truncates to `width` visible
  characters. The `ellipsis` is appended and counted against `width`. ANSI codes
  that fall before the cut point are preserved; codes after are dropped.

`src/builtin-skills/languages/node/SKILL.md`:
- Added "ANSI truncation" bullet with the inline implementation snippet, so local
  models see the correct pattern when `lang:node` is active.

## Done criteria

- [x] `src/ansi-utils.mjs` exports `visibleWidth` and `truncateVisible`.
- [x] 12 unit tests (visibleWidth + truncateVisible) all pass.
- [x] `lang:node` skill extended with ANSI truncation guidance and snippet.
- [x] `npm run build-skills` run; `builtin-skills.json` updated.
- [x] `npm run format` passes.
- [x] `npm run check` passes.
- [x] Committed.
