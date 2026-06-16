# Phase 165: `kodr check --json`

`kodr check` now speaks JSON.

```sh
$ kodr check --json --no-smoke --no-sensors
{
  "ok": true,
  "command": "check",
  "syntax": {
    "ok": true,
    "checked": 14,
    "failures": []
  }
}
```

Without `--json`, output is the same ANSI text as before. With it, stdout is
pure JSON: `ok`, `command`, and whichever gate fields ran (`syntax`,
`smokeCheck`, `sensors`). Gates suppressed with `--no-smoke` or `--no-sensors`
are simply absent from the object.

This makes `kodr check` usable from CI scripts that want machine-readable gate
results without parsing terminal colour codes:

```sh
result=$(kodr check --json --no-smoke)
ok=$(echo "$result" | jq -r '.ok')
failures=$(echo "$result" | jq -r '.syntax.failures | length')
```

The implementation refactored `check.mjs` to collect all gate results into a
`checkResult` object first, then either call `renderAnsi` (the existing path)
or `JSON.stringify` (new path). No gate logic changed; only the output step
branches on `options.json`.
