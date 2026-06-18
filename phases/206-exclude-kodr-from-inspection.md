# Phase 206: Exclude .kodr from Inspection File Index

## Goal

Prevent `.kodr/` from appearing in the workspace inspection index, specifically so
that `.kodr/backups/` does not pollute the model's context with stale file versions.

## Done criteria

- [x] `.kodr` added to `DEFAULT_IGNORES` in `src/repomap/workspace-files.mjs`
- [x] Test: `inspectWorkspace` does not index `.kodr/backups/` files by default
- [x] README updated: `.kodr` is now baked in, not caller-supplied
- [x] Phase committed with passing tests
