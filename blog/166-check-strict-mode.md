# Phase 166: `kodr check --strict`

`kodr check` has always failed on syntax errors. The smoke-check and
cross-reference sensor warnings were advisory — they showed up in output but
exit code stayed 0. That's the right default for interactive use where a sensor
false-positive shouldn't block a commit.

`--strict` changes that contract:

```sh
# Pre-commit hook
kodr check --strict
```

With `--strict`, any smoke-check `failed` result or sensor `warn` also drives
exit 1. Sensor `warn` includes the compose ↔ Dockerfile mismatch and the CSS
selector ↔ HTML mismatch. The smoke outcomes `timeout` and `skipped` are still
not promoted — they remain inconclusive (no DB available, entry uses
`exports`-only, etc.).

Works with `--json`:

```sh
result=$(kodr check --json --strict)
ok=$(echo "$result" | jq -r '.ok')
# ok is false if strict promoted any warning
```

Typical pre-commit `.kodr/hooks.json`:

```json
{ "PreToolUse": ["kodr check --strict --no-sensors"] }
```

Or as a plain shell hook:

```sh
#!/bin/sh
kodr check --strict
```

The implementation is a post-gate pass in `check.mjs`: after all gates complete,
if `options.strict`, any smoke `failed` or sensor `warn` flips `checkResult.ok`
to false before the output step.
