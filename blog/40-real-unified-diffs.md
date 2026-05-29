# Phase 40: Real Unified Diffs

`makeDiff` in `src/safe-writes.mjs` used to emit a pseudo-diff: every line of the
old file as `-`, every line of the new file as `+`, under a `---`/`+++` header.
For a one-line change in a 200-line file that's 400 lines of noise that hide the
actual change. Since the diff is what a user reviews before approving a write
(dry-run is the default), that's exactly the wrong place to be unreadable. Phase
40 replaces it with a real line-level unified diff.

Before:

```
--- math.mjs
+++ math.mjs
-function add(a,b){
-  return a+b
-}
-
-export {add}
+function add(a, b) {
+  return a + b;
+}
+
+function sub(a, b) {
+  return a - b;
+}
+
+export { add, sub }
```

After:

```
--- math.mjs
+++ math.mjs
@@ -1,6 +1,10 @@
-function add(a,b){
-  return a+b
+function add(a, b) {
+  return a + b;
 }
 
-export {add}
+function sub(a, b) {
+  return a - b;
+}
 
+export { add, sub }
```

The unchanged `}` and blank lines are now context (space-prefixed), and the hunk
header tells you where you are.

## Zero dependency, on purpose

The kodr tool stays Node-built-ins-only, so no `diff`/`jsdiff`. A line-level
unified diff doesn't need one. It's two pieces:

**LCS line diff (~30 lines).** A dynamic-programming longest-common-subsequence
over the two line arrays, then a single forward walk that emits `eq` / `del` /
`ins` ops. Each op is annotated with the 1-based old/new line number as it stood
*before* the op, which is all the hunk header needs later.

**Hunk assembly (the fiddly part).** Turning the op stream into
`@@ -a,b +c,d @@` blocks is where the real care goes: find the changed ops,
group ones that sit within `2*CONTEXT` equal lines of each other into the same
hunk, pad each cluster with up to `CONTEXT` (3) lines of context, and count the
old/new spans. New files get `-0,0` because the old side is empty. This is
bookkeeping, not algorithm — and it's where most of the tests point.

## Choosing LCS over Myers

Real `git diff` uses Myers' O(ND) algorithm, which produces marginally more
"human" diffs in pathological cases. We deliberately didn't. Plain LCS is
correct and perfectly readable for source files, and it's understandable in one
sitting — the better choice for a learning repo. Myers is more code for a
benefit this project never feels.

## The cost, and the bound

LCS is **O(m×n)** in time and memory: an `(m+1)×(n+1)` table (`Int32Array` rows
keep it tight). For the small apps kodr generates that's nothing. But a giant
file would blow up memory, so there's a hard bound: if either side exceeds
`DIFF_MAX_LINES` (2,000), skip the LCS path and fall back to the old whole-file
`-`/`+` dump. That keeps memory bounded and is a documented, named limit rather
than a silent OOM. The fallback is still a valid (if noisy) diff, so nothing
downstream breaks.

## Testing

`makeDiff` is now exported so the cases can be tested directly as a pure
function: insert-only (new file → `-0,0 +1,N`, no `-` lines), delete-only (no `+`
lines), a mixed change with surrounding context, no-change (header only, zero
hunks), distant changes splitting into two hunks, and the over-threshold
fallback (no hunk headers, bulk `-`/`+`). One gotcha the tests caught in
*themselves*: a naive `/\n\+/` "no additions" check matches the `+++` header, so
the assertions anchor to single `+`/`-` line prefixes with `/^\+[^+]/m`.
