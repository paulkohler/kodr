# Phase 197: `kodr hook status --json`

`kodr hook status` was the only hook subcommand that didn't support `--json`.
Scripts had to parse the human text to get hook state — brittle and fragile.

## Usage

```sh
kodr hook status --json
```

Output when hooks are installed:

```json
{
  "ok": true,
  "command": "hook",
  "hookStatus": "kodr",
  "hookStatuses": {
    "pre-commit": "kodr",
    "pre-push": "none"
  },
  "hookPath": "/path/to/.git/hooks/pre-commit"
}
```

`hookStatus` is the pre-commit status (kept for backward compatibility).
`hookStatuses` gives both hooks explicitly.
`hookPath` is only present when the pre-commit hook is installed.

## Use in CI / scripts

```sh
status=$(kodr hook status --json | node -e "process.stdin.setEncoding('utf8'); let d=''; process.stdin.on('data',c=>d+=c); process.stdin.on('end',()=>console.log(JSON.parse(d).hookStatuses['pre-commit']))")
echo "pre-commit: $status"   # kodr / foreign / none
```

The `--json` flag was already parsed globally — `runHookStatus` just wasn't
using it.
