# Phase 199: `kodr hook install/uninstall --json`

## Motivation

Phase 197 added `--json` to `kodr hook status`, completing the read side.
Phases 198 documented the hook subcommands in help. The write side
(`install`, `uninstall`) remained text-only, making scripted workflows
that inspect the installed path or command need to parse text.

## What this phase does

`runHookInstall` and `runHookUninstall` now check `options.json`:

- **install**: emits `{ ok, command, hookPath, hookName, cmd }` as JSON.
  `cmd` is the command string baked into the hook script (from config or default).
  No text lines are written when `--json` is set.
- **uninstall**: emits `{ ok, command, hookPath, hookName }` as JSON.
  No text lines are written when `--json` is set.

Error paths (non-git-repo, foreign hook without --force, missing hook) still
write to stdout as text regardless of `--json` — error output is always human-readable.

## Done criteria

- [x] `runHookInstall` respects `options.json`.
- [x] `runHookUninstall` respects `options.json`.
- [x] 2 new tests: `--json emits structured JSON with hookPath and cmd` (install);
      `--json emits structured JSON with hookPath` (uninstall).
- [x] `npm run format` passes.
- [x] Tests pass.
- [x] Committed.
