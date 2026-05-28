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

## Done Criteria

- [ ] `makeDiff` produces hunked unified diffs with context lines.
- [ ] Pure Node implementation, no new dependencies.
- [ ] Tests cover insert-only, delete-only, mixed, and no-change cases.
- [ ] Existing safe-writes and replay tests updated for the new format.
- [ ] Record decisions and any failures.
- [ ] Blog post.
