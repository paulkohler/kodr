# Phase 198: Help Text Update for Missing Commands and Flags

## Motivation

Several features shipped in recent phases (191–197) were never added to the help
text. The `kodr hook install/status/uninstall` subcommands had no usage examples.
`--fix` and `--watch` were missing from the `kodr check` usage line and had no
help entries. The `sensors` and `hooks` config blocks in `.kodr/config.json`
weren't documented.

## What this phase does

**Usage line** (`src/cli/args.mjs` usage section):
- `kodr check` line: added `[--fix]` and `[--watch]`
- Added 3 new lines: `kodr hook install`, `kodr hook status [--json]`,
  `kodr hook uninstall`

**Help entries** (long-form description section):
- `--fix` entry explaining the repair-and-recheck flow
- `--watch` entry explaining debounce and Ctrl-C exit
- `kodr hook install`, `kodr hook status`, `kodr hook uninstall` full descriptions

**Config help**:
- `sensors` block (`{ "sensors": { "sensor-name": false } }`)
- `hooks` block (`{ "hooks": { "preCommit": "cmd", "prePush": "cmd" } }`)

## Done criteria

- [x] `kodr check` usage line includes `--fix` and `--watch`.
- [x] Usage section includes `kodr hook install/status/uninstall`.
- [x] Help entries for `--fix`, `--watch`, and all three hook subcommands.
- [x] Config help documents `sensors` and `hooks` blocks.
- [x] `npm run format` passes.
- [x] `npm run check` passes.
- [x] `kodr --help` verified to show new entries.
- [x] Committed.
