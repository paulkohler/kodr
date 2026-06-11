# Phase 104: Daily-Driver TUI Polish

The TUI has been functional since phase 45, but "functional" and "pleasant to
use daily" are different things. Phase 104 closes four gaps that kept the
session loop from feeling like a real tool rather than a prototype.

## Colored Diffs in the Review Pane

The biggest visual improvement. Before this phase, `/review` listed file paths
and wrote-N counts. After, it renders the actual unified diff with ANSI colors:
bold for the `---`/`+++` header lines, cyan for `@@` hunk markers, green for
added lines, red for removed lines. Context lines stay plain.

The implementation is in `renderColoredDiff(writes, view)`. It reads each
write's `.diff` field — already populated by the phase-40 diff machinery — and
maps line prefixes to view colors. The function is also called automatically
from `renderPendingReview`, so the colored diff appears right after a dry-run
turn without needing a separate `/review` command.

Adding `cyanText` to `createTuiView` was necessary because the existing
`infoText` method prepends the `assistant>` label, which is correct for
assistant messages but wrong for raw diff line markup.

## `@file` References

Typing `@src/tui.mjs` in a prompt now inlines the file's content before the
prompt text reaches the model. The pattern is `@` followed by a path-like
string ending in a dotted extension. Multiple refs are supported; duplicate
refs are deduplicated; missing files are silently skipped so a typo does not
break a turn.

`expandFileReferences(text, cwd)` returns `{expandedPrompt, files}`. The
expanded prompt prepends each file as a fenced code block under a `## @path`
heading, then appends the original prompt unchanged. The channel sees the full
context; the user sees a brief `attached: file.js (N chars)` note on the
assistant line.

This is zero-dependency — just `readFile` from `node:fs/promises` and
`join` from `node:path`, both already imported for other reasons or added to
the import list.

## Footer Line

Every turn now ends with a single dim gray line:

```
[model=qwen/qwen3-35b] [session=abc123] [tokens prompt=1420 completion=312 total=1732]
```

`renderFooter(state, result, view)` assembles it from state and the result's
`usage` object. Token counts are omitted when the local model sends no usage
data (common with LM Studio), keeping the footer uncluttered. The `[review
pending]` indicator appears when a dry-run result is waiting for `/accept` or
`/reject`. `/status` also appends the footer so the same information is
available on demand.

## `/retry`

`/retry` re-runs the last prompt with the current session state. This is the
shortest path to "that response was bad, try again" without retyping. It
restores the `lastPrompt` field stored after each completed turn.

`/retry --model <id>` swaps the model for a single retry and restores the
original afterwards, which makes quick one-off model comparisons practical
without permanently changing the session's model.

## Testing Notes

Ten new tests cover all four features. The diff-coloring test imports
`createTuiView` with `FORCE_COLOR=1` to get actual ANSI sequences rather than
plain text, then asserts against specific escape codes (`\[1m` for bold,
`\[36m` for cyan, etc.). The `expandFileReferences` tests write real temp files
and clean up with `rm`. The `/retry --model` test verifies that `state.model`
is restored to its original value after the retry completes, not left at the
temporary override.

A note on the `infoText` vs `cyanText` fix: the first attempt used
`view.infoText` for `@@` lines, which produces `\x1B[36massistant>\x1B[39m
\x1B[90m@@ -1,3 ...\x1B[39m` — the label is cyan, the hunk text is gray.
Adding `cyanText` to the view gave a direct `\x1B[36m@@...\x1B[39m` without
the label, which is both visually correct and easier to assert against in tests.
