# Phase 99: Optional LSP Adapter

The external inspector registry has had phantom entries since phase 53. Four
language server names sat in the registry claiming `--json` flags those tools
have never had. `gopls --json`, `rust-analyzer --json`,
`typescript-language-server --json` — none of these interfaces exist. Phase 53
deliberately used fake commands in tests so the registry shape could be validated;
the real tools were never checked. Pyright's `--outputjson` flag is real, but it
emits a diagnostics report, not the `{ files: [...] }` index shape
`adaptJsonOutput` expects, so every run of it normalised to nothing.

Phase 97 made this worse. Defaulting `inspectContext` to `auto` meant
`inspectWithRegistry` ran on every bare kodr run. `checkAvailability` probed
each registered command with `--version` on machine startup, and on any machine
with gopls or rust-analyzer installed, kodr spawned real binaries with bogus
arguments on every prompt — wasted spawns at best, multi-second stalls at worst.

Phase 99 fixes this correctly, not by finding better flags (there are none), but
by speaking the protocol these tools actually implement: Language Server Protocol
over stdio.

## The Real Protocol

Language servers are not one-shot JSON CLIs. They are long-running processes that
communicate with a bidirectional stream of Content-Length framed JSON-RPC
messages. The lifecycle is:

1. Client spawns server, sends `initialize` (with capability negotiation)
2. Server responds with its capabilities, client sends `initialized`
3. Client opens files with `textDocument/didOpen`, requests symbols, waits for
   diagnostics
4. Client sends `shutdown` and `exit`, server terminates

`src/lsp-client.mjs` implements this lifecycle from scratch using Node 24
builtins (`node:child_process`, `node:url`, no npm dependencies). The framing
decoder tolerates messages split across chunks and multiple messages per chunk
without hanging. Every stage has a per-request timeout and a per-run budget;
partial results are kept, the rest falls back to the built-in index.

## Registry Overhaul

The four invented CLI entries are replaced by LSP entries with their real stdio
invocations:

```javascript
{ protocol: 'lsp', command: 'gopls',                      args: [] }
{ protocol: 'lsp', command: 'pyright-langserver',          args: ['--stdio'] }
{ protocol: 'lsp', command: 'rust-analyzer',               args: [] }
{ protocol: 'lsp', command: 'typescript-language-server',  args: ['--stdio'] }
```

The `'cli'` protocol machinery (`runInspectorCommand`, `adaptJsonOutput`) is
kept for tools that genuinely emit one-shot JSON, but the default registry ships
zero CLI entries. A new registry-hygiene test asserts this invariant, so the
invented-flags regression cannot quietly return.

## Normalization

LSP results normalize onto the existing `InspectedFile` merge path:

- `SymbolKind` maps onto repomap kinds: Function/Method → `function`,
  Class/Interface/Struct/Enum → `class`, Variable/Constant/Field → `variable`.
  Names matching test heuristics (`TestX`, `test_x`) keep kind `test`.
  Unmapped kinds drop rather than invent new kinds.
- Servers may return hierarchical `DocumentSymbol[]` (with `children`) or flat
  `SymbolInformation[]`; both are handled, children flattened.
- LSP positions are 0-based; repomap lines are 1-based. Conversion is applied
  at normalization, not at the call site.
- `textDocument/publishDiagnostics` pushes are collected during a bounded window
  after `didOpen` and attached as `lspDiagnostics` in the `InspectedFile`.

Merged results flow through the existing `mergeInspectorResults` path:
LSP-covered files take precedence, the built-in index fills gaps, `contentLines`
survive (ranking and chunk building still need them), and re-ranking runs.

## Opt-in Gating

LSP is off by default. Three ways to enable it, with phase 96 precedence:

```sh
kodr run -p "..." --lsp          # flag (highest precedence)
kodr run -p "..." --no-lsp       # explicit off
```

```json
{ "lsp": true }                  # .kodr/config.json — all registered servers
{ "lsp": ["gopls"] }             # restrict to named servers
```

Config accepts `true` or an array of known server names. Arbitrary command
strings are rejected loudly by name — a cloned repository's config must never
choose what binary kodr executes. The resolution source appears in
`kodr run --show-config`.

## Security Boundary

Enabling LSP can execute repository code. `rust-analyzer` runs build scripts and
proc-macros; `gopls` invokes the go toolchain. This is why the default is off and
why config-supplied command strings are banned. The usage.md documents this
caveat where it describes the flag. Model output never reaches the LSP process —
the adapter is driven off the walker's file list, not model instructions.

## Test Architecture

The fake-lsp-server fixture (`test-support/fake-lsp-server.mjs`) speaks real
Content-Length framed JSON-RPC over stdio, following the phase 03 fake-model-server
pattern. Tests cover:

- Framing: decoder tolerates splits and multi-message chunks, handles a
  server that pushes symbols followed immediately by diagnostics
- Lifecycle: clean handshake and shutdown; a server that never answers
  `initialize` is killed at timeout
- Normalization: hierarchical `DocumentSymbol[]`, flat `SymbolInformation[]`,
  0-to-1-based conversion, test-heuristic kind, unmapped-kind drop
- Merge: LSP symbols replace base, `contentLines` survive, re-ranking runs
- Gating: `lsp: false` spawns nothing, `lsp: true` and `lsp: ['name']` route
  correctly, config with command string or unknown name fails at load time

## What Did Not Change

A bare run with no `--lsp` and no config key spawns no external process. The
phase 97 auto-inspection path uses the built-in index only. This is the regression
lock for the phase: the bogus spawns are gone and cannot return.

`src/repomap/` is untouched. The phase 95 boundary test is still green. Tool
schemas, ranking weights, chunk selection, prompt text, and artifact formats are
unchanged.
