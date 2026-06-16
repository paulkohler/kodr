# Phase 154: A Guard for the Hand-Copied Package Tree

`@kodr/repomap` is the extractable library carved out of Kodr's repo-map code back
in phase 95. It lives at `packages/repomap/`, and its `src/` is a **manual copy** of
the canonical `src/repomap/` tree that the app actually imports
(`external-inspector-registry.mjs`, `context-packer.mjs`, and friends all
`import … from './repomap/index.mjs'`). The package tree exists only so the library
can be published independently.

The problem with a manual copy is the obvious one: nothing enforces the "manual."
Fix a bug in `src/repomap/inspector.mjs`, forget to mirror it into
`packages/repomap/src/inspector.mjs`, and the published package quietly ships the
old code. No import breaks — the app uses the canonical tree, so its tests stay
green — and the drift only surfaces when someone installs `@kodr/repomap` and hits a
bug that was fixed months ago in the repo it came from.

## The cheapest possible guard

This doesn't need a build step or a codegen tool. It needs a test that fails the
moment the two trees disagree. `test/repomap-sync.test.mjs`:

- Lists the `.mjs` files in each tree and asserts the **sets match** — so a new
  canonical module that wasn't copied fails, and so does a stale package module with
  no source behind it.
- Asserts each shared `.mjs` file is **byte-identical** across the trees.
- Scopes strictly to `.mjs`. `README.md`, `LICENSE`, and `package.json` are
  legitimately tree-specific (the package carries its own), so they're excluded.

Every failure names the file and the fix direction — *"copy `src/repomap/render.mjs`
to `packages/repomap/src/render.mjs`"* — because a guard that just says "trees
differ" makes you go find out how.

## Verify before, and verify it bites

Two checks before calling it done. First, the trees were confirmed in sync up front
(all six `.mjs` files byte-identical; only `README.md` differs) — so this is a
guard against future drift, not a quiet reconciliation of existing drift that should
have been a separate, reviewed change.

Second, the negative control. A guard test that can't fail is decoration, so I
perturbed it on purpose: append one comment line to
`packages/repomap/src/render.mjs`, and the suite reports

```
render.mjs has drifted from src/repomap/render.mjs — copy src/repomap/render.mjs to packages/repomap/src/render.mjs
```

`git checkout` restores the file and the suite goes green again. The guard bites.

## On the publish decision

This is deliberately *not* a decision to publish `@kodr/repomap`. That hold is
parked pending more dogfooding and remains a human call in `NEXT.md`. The sync test
was always the part that could land independently: it protects the package tree
whether or not it's ever pushed to a registry, and it removes one excuse to keep
deferring — the copy can no longer rot in the dark.

Full suite 1,480 green (+7).
