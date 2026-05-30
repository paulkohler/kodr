# Phase 53: External Inspector Registry

Phase 51 built a zero-dependency structural index. Phase 52 wired it into
context packing. Phase 53 adds a registry layer that lets installed language
tools enrich that same index without making them required.

## The Problem

Regex-based symbol extraction is portable and fast, but shallow. A language
server can provide accurate type info, cross-file references, and correct scope
boundaries. The question is how to get that richer data without coupling Kodr
to any particular tool.

## The Registry Shape

Each external inspector is a plain object:

```js
{
  name: 'gopls',
  languages: ['go'],
  command: 'gopls',
  buildArgs: (files, cwd) => ['--json', ...files],
  adapt: (stdout) => [/* normalized InspectedFile[] */],
  timeout: 10000,
  onFailure: 'skip',
}
```

The `adapt` function maps whatever the tool emits into the same shape that
`inspectFile` returns. That normalized shape — `{ path, language, lineCount,
imports, symbols }` — is the only contract between the registry and the rest of
Kodr.

## Availability at Runtime

Before running any tool, `checkAvailability` spawns the command with
`--version` and checks whether it errors with `ENOENT`. Any other exit behavior
(including non-zero) still counts as present — the tool exists, it just
complained about the flag. This keeps discovery lean with no `which` dependency.

## Merge Strategy

External results take precedence over the built-in index for any file they
cover. When a language server returns richer symbols for `main.go`, that
replaces the regex scan. Files not covered by the external tool keep their
built-in scan. New files reported by the external tool are appended.

## Failure Behavior

Each descriptor carries `onFailure: 'skip' | 'throw'`. The default is `skip`:
a timed-out or failing tool is silently ignored and the built-in index stands.
This makes every external inspector genuinely optional.

## Tests

All tests use fake descriptors backed by `process.execPath` (node itself) with
`-e` one-liners that emit controlled JSON. No external tools are required to
run the test suite.

Tested paths:
- `adaptJsonOutput` — envelope and bare-array forms, malformed input
- `checkAvailability` — present and missing commands
- `runInspectorCommand` — stdout capture, nonzero exit, timeout
- `discoverInspectors` — language filtering, missing commands
- `mergeInspectorResults` — pass-through, replacement, append, symbol rebuild
- `inspectWithRegistry` — no-tool fallback, successful enrichment, failing tool

## What Is Not Here Yet

No real LSP integration. The registry entries for `gopls`, `pyright`,
`rust-analyzer`, and `typescript-language-server` are stubs — the command,
args, and a generic JSON adapter are placeholders. Phase 54 will wire actual
tool calls through the registry using this shape.
