# Phase 40: Real Unified Diffs

## Goal

`makeDiff` in `src/safe-writes.mjs` currently emits a pseudo-diff: every line of
the old file as `-`, every line of the new file as `+`, under a `---`/`+++`
header. For a one-line change in a 200-line file this prints 400 noisy lines and
hides what actually changed. Replace it with a real line-level unified diff so
proposal previews are readable and reviewable.

## Design

- Implement a minimal LCS (longest common subsequence) line diff in pure Node —
  no dependencies (the kodr tool itself stays dependency-free).
- Emit standard unified-diff hunks (`@@ -a,b +c,d @@`) with a few lines of
  context around each change.
- Keep the `--- path` / `+++ path` header so existing artifact readers and the
  replay flow still recognise the format.
- Preserve the create-vs-modify distinction already encoded in the write status.

## Algorithm choice and the large-file bound

Use plain LCS (longest common subsequence) over line arrays, not Myers' O(ND)
diff. LCS is ~30 lines, understandable in one sitting, and produces correct,
readable diffs for source files — the right teaching choice for this repo. Myers
yields marginally more "human" diffs in pathological cases but is more code than
the project needs.

The tradeoff: LCS is **O(m×n)** in time and memory (an `(m+1)×(n+1)` table). For
the example apps kodr generates (hundreds of lines) that is negligible, but a
very large file would blow up memory. So cap it: if either side exceeds a line
threshold (e.g. **2,000 lines**), skip the LCS path and fall back to the current
whole-file `-`/`+` dump. This keeps memory bounded and is a deliberate,
documented limit rather than a silent failure mode — record it as a decision.

## Done Criteria

- [x] `makeDiff` produces hunked unified diffs with context lines.
- [x] Pure Node implementation, no new dependencies.
- [x] Large-file bound: files over the line threshold fall back to the
      whole-file `-`/`+` dump; the threshold is a named constant.
- [x] Tests cover insert-only, delete-only, mixed, no-change, and the
      over-threshold fallback cases.
- [x] Existing safe-writes and replay tests updated for the new format.
- [x] Record decisions and any failures.
- [x] Blog post.
