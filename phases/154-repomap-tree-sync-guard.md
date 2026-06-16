# Phase 154 — @kodr/repomap Tree-Sync Guard

## Motivation

`packages/repomap/src/` is a **manual copy** of `src/repomap/`. The app imports the
canonical tree (`src/external-inspector-registry.mjs`, `context-packer.mjs`, … all
`import … from './repomap/index.mjs'`); the package tree exists only to publish
`@kodr/repomap`. There is no script and no test keeping the two in step. A bug fix
or feature landed in `src/repomap/inspector.mjs` and not mirrored into
`packages/repomap/src/inspector.mjs` would silently ship stale code in the package
— and nothing in CI would notice.

NEXT.md called this out as landable regardless of the parked publish decision: a
sync check is pure repo integrity, independent of whether/when `@kodr/repomap` is
published.

(Verified before writing: the six `.mjs` files are currently byte-identical across
the two trees; only `README.md` differs — it lives in `src/repomap/` but the
package carries its own top-level `README.md`/`LICENSE`/`package.json`. So this
phase adds a guard against future drift, not a reconciliation of existing drift.)

## Change

Add `test/repomap-sync.test.mjs` (no production code change):

- Treat `src/repomap/` as canonical and `packages/repomap/src/` as the publish
  mirror.
- Assert the set of `.mjs` files matches exactly (catches a new canonical module
  not copied, and a stale package module with no canonical source).
- Assert each shared `.mjs` file is byte-identical between the trees.
- Scope to `.mjs` only: `README.md` and package metadata are intentionally
  tree-specific and excluded.

The failure message names the offending file and the fix ("copy `src/repomap/<f>`
to `packages/repomap/src/<f>`"), so a drift is self-explaining.

## Testing

- New `test/repomap-sync.test.mjs` passes against the current (in-sync) trees.
- `npm run format` + `npm run check` + full suite green.

## Done criteria

- [x] `test/repomap-sync.test.mjs` asserts `.mjs` file-set equality + byte-identity
      across `src/repomap/` and `packages/repomap/src/`, with actionable failure
      messages. Negative control: a one-line perturbation of a mirror file fails
      the guard with the "copy …" message; `git checkout` restores green.
- [x] `npm run format` + `npm run check` + full suite green (1,480 — +7).
- [x] Blog `blog/154-*`; decisions entry; NEXT.md updated (sync-check sub-item
      removed; publish-hold paragraph kept — still a human call); roadmap line;
      version 0.0.154.
