# Phase 172: Import Cycle Detection Sensor

Phase 167 added a sensor that flags missing import targets. Phase 172 adds the
complementary check: do any of those imports form a cycle?

## Why cycles matter

Node.js does not throw on circular imports — it silently returns the partially-
initialised module to break the loop. The practical result is that code which
looks like:

```js
// a.mjs
import { b } from './b.mjs';
export const a = b + 1;

// b.mjs
import { a } from './a.mjs';
export const b = a + 1;
```

produces `b = NaN` at runtime because when `b.mjs` evaluates, `a` from `a.mjs`
is still `undefined`. The error only surfaces when you run the code, and the
root cause is invisible in any single file.

## The algorithm

`buildImportGraph` reads each JS file in the write set, extracts relative
imports, resolves them to workspace-relative paths, and builds an adjacency map
restricted to edges between files that are both in the write set.

`findCycles` runs DFS with a `visiting` set (nodes on the current stack) and a
`visited` set (fully explored nodes). When DFS encounters a node already in
`visiting`, it extracts the cycle from the stack and records it.

Cycles are deduplicated by rotating each cycle so the lexicographically smallest
node appears first, then stringifying for Set membership.

## Refactoring `resolveLocalImport`

The existing function was a boolean check. To build the graph, the cycle sensor
needed the resolved absolute path, not just a true/false result. The fix was to
extract `resolveLocalImportAbs` as a shared helper that returns `string | null`,
and make `resolveLocalImport` a thin boolean wrapper. Both the local-import
sensor and the cycle sensor share the same resolution logic.

## Scope: write-set-only

The sensor only tracks edges between files in the write set. Cycles that span
outside the write set (e.g. `written.mjs → existing.mjs → written.mjs`) are not
detected. This is consistent with the other sensors and keeps the sensor fast on
large workspaces. The most common model mistake — writing two new files that
mutually import each other — is squarely in scope.
