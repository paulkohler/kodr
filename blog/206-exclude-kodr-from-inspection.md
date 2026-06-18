# Phase 206: Exclude .kodr from Inspection File Index

## The problem

Multi-session examples on qwen3.6-35b-a3b (a thinking model) were failing with
"POST /chat/completions did not return a usable assistant message" — the same
error that Phase 205 was supposed to fix.

Adding debug output showed the actual response body: `content: ""` with a huge
`reasoning_content` full of the model looping on "I need to construct patches
now... let me think about this... I need to be careful...". The model was
reasoning forever without converging.

## Root cause

The inspection context included `.kodr/backups/` files. When Session 1 applies
writes, kodr saves backups under `.kodr/backups/<timestamp>/src/...`. These
backup files contain the *pre-Session-1* API (e.g., a singleton `getDb()`
helper). Session 2 then sees both:

- `src/tasks.mjs` with the db-as-parameter API (current)
- `.kodr/backups/.../src/tasks.mjs` with the old singleton API (stale)

The model sees contradictory function signatures for the same file. With a
thinking model that reasons extensively before acting, this causes a reasoning
loop: "but the backup shows getDb()... but the current file shows db-as-param...
let me read again... I need to be careful about the exact search strings..."
The model exhausts its available token budget on reasoning and produces no
content.

## The fix

Add `.kodr` to `DEFAULT_IGNORES` in `src/repomap/workspace-files.mjs`. This
is a one-line fix: the `.kodr` directory (runs, backups, config) is never
source code, so it should never be in the inspection index.

The README example showing how to pass `.kodr` via `ignorePatterns` is updated
to note it is now baked in.

## Lesson

Backup/metadata directories that contain old versions of source files are
worse than just noisy — they actively mislead thinking models that try to
reconcile contradictions. Exclude them unconditionally.
