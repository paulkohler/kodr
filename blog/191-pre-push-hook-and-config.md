# Phase 191: Pre-push Hook and Configurable Hook Lifecycle

The pre-commit hook has been the only git hook kodr managed. It runs fast — only
changed files, only the strict gate — but once work is ready to share, a fuller
check before push is useful. Phase 191 adds that.

## `kodr hook install --pre-push`

```sh
kodr hook install          # .git/hooks/pre-commit  — kodr check --changed --strict
kodr hook install --pre-push  # .git/hooks/pre-push — kodr check --strict
```

The pre-push hook runs the full tree (no `--changed`), so it catches issues that
slipped past the fast per-commit gate.

## `kodr hook status` now covers both

```
pre-commit hook: installed by kodr
  path: .git/hooks/pre-commit
pre-push hook: not installed
```

Both hooks are always reported in one call.

## Config-driven commands

If the default command isn't right for a project, override it in `.kodr/config.json`:

```json
{
  "hooks": {
    "preCommit": "kodr check --changed --strict --deep",
    "prePush":   "kodr check --strict --deep"
  }
}
```

The install command reads the config and bakes the custom command into the script.
This lets a team pin `--deep` or add `--no-sensors` without hand-editing the hook.

## Kodr integration test

`~/src/kodr-testing/phase-191/hook-pre-push-test/`:
- `kodr hook install` → `kodr check --changed --strict` in pre-commit
- `kodr hook install --pre-push` → `kodr check --strict` in pre-push
- `hook status` → both shown as `installed by kodr`
- Config override via `.kodr/config.json` `hooks` block → `--deep` variants baked in
- `hook uninstall --pre-push` → pre-push removed; pre-commit intact
