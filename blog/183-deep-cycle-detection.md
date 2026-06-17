# Phase 183: `kodr check --deep` Cross-Workspace Cycle Detection

## The gap

The import-cycle sensor only checked cycles *within* the write set. If you wrote
`auth.mjs` that imports `session.mjs` (an existing file) which imports back to
`auth.mjs`, the cycle was invisible because `session.mjs` was never in the graph.

## The fix: BFS transitive closure

`--deep` switches to a BFS-based graph builder that starts from the write set
and follows imports into existing workspace files:

```
$ kodr check --changed --deep
⚠ import-cycles         1 import cycle: auth.mjs → session.mjs → auth.mjs
```

Without `--deep`, the same check misses it:

```
$ kodr check --changed
✔ import-cycles         1 file ok — no import cycles
```

## Relevance filter

In large repos, following all imports transitively could surface many pre-existing
cycles that have nothing to do with the current change. The sensor filters to
cycles that include at least one node from the original write set, so you only
see cycles you may have introduced.

## When to use it

Best combined with `--changed` (short write set + targeted scope):

```sh
kodr check --changed --deep --strict
```

The pre-commit hook (installed by `kodr hook install`) uses `--changed --strict`
by default; add `--deep` to the hook script if you want transitive detection on
every commit.
