# Phase 99: Optional LSP Adapter

Renumbered from phase 75; deliberately sequenced last as a capability add.

## Summary

Add an opt-in Language Server Protocol path to the external inspector
registry (phase 53) so installed language servers can enrich the structural
index with real semantic symbols, references, and diagnostics. The adapter
speaks actual LSP — framed JSON-RPC over stdio with the initialize
handshake — instead of the invented one-shot CLI flags the registry ships
today. LSP stays external and off by default: no bundled servers, no
auto-install, and a bare `kodr run` spawns no LSP process. The built-in
regex index (`src/repomap/`) remains the portable baseline and the fallback
for every failure mode.

## Motivation

- The current external inspector entries have never produced enrichment.
  `REGISTRY` in `src/external-inspector-registry.mjs` invokes
  `gopls --json`, `rust-analyzer --json`, and
  `typescript-language-server --json` — interfaces none of those tools
  have; they are LSP servers, not one-shot JSON CLIs. `pyright
  --outputjson` is a real flag, but it emits a diagnostics report, not the
  `{ files: [...] }` index shape `adaptJsonOutput` expects, so it adapts
  to `[]`. Every entry either fails or normalizes to nothing, and
  `inspectWithRegistry` silently `continue`s past it.
- Phase 97 made this dead path run on every bare run. `inspectContext`
  now defaults to `'auto'`, so `createInspectionContext` in `src/app.mjs`
  calls `inspectWithRegistry` per run; `checkAvailability` probes each
  registered command with `--version`, and on a machine with gopls or
  rust-analyzer installed, kodr spawns real binaries with bogus arguments
  on every prompt — wasted spawns at best, multi-second stalls at worst
  (each entry gets a 10s `DEFAULT_TIMEOUT`).
- This is the standing counterexample to the AGENTS.md rule that
  external-tool integrations must be checked against the tool's documented
  semantics. The fix is not better flags — these tools have no such
  flags — it is speaking the protocol they actually implement.
- The built-in index has accuracy limits it was designed to accept
  (phase 51 chose regex portability over parsing): `findReferences` is a
  word-boundary text match, so it counts comments and strings and misses
  semantic references that don't share the literal name; symbols carry no
  hierarchy or types. Where a real server is installed, kodr should be
  able to use real answers — without ever requiring one.

## Design

### LSP client

New app-side module `src/lsp-client.mjs` (Node 24 builtins only:
`node:child_process` plus a hand-rolled framing parser). It stays outside
`src/repomap/` — phase 95's boundary test requires the library to import
nothing but node builtins and sibling files, and process management is an
app concern, same as `external-inspector-registry.mjs`.

Scope is the minimal lifecycle and four operations:

- Framing: `Content-Length` headers over stdio, tolerant of messages
  split across chunks and multiple messages per chunk.
- Lifecycle: spawn → `initialize` (advertise only the capabilities we
  consume) → `initialized` → requests → `shutdown` → `exit`, with a kill
  on timeout at every stage. Servers index lazily (rust-analyzer and
  gopls can take seconds before first useful answers), so every request
  gets a per-request timeout and the whole enrichment pass gets a
  run-level budget; partial results are kept, the rest falls back.
- Operations: `textDocument/documentSymbol` (after `textDocument/didOpen`
  with the file content the walker already read), `workspace/symbol`,
  `textDocument/references`, and diagnostics collected from
  `textDocument/publishDiagnostics` pushes during a bounded window after
  didOpen. No `didChange` sync — files are opened read-only, queried,
  closed.

### Registry integration

Registry descriptors gain a `protocol: 'cli' | 'lsp'` field. The four
invented CLI entries are replaced by LSP entries with their real
invocations:

- `typescript-language-server --stdio` (javascript, typescript)
- `pyright-langserver --stdio` (python)
- `rust-analyzer` (rust; stdio is its default)
- `gopls` (go; stdio is its default)

The `'cli'` protocol machinery (`runInspectorCommand`, `adaptJsonOutput`,
the fake-command tests) stays for tools that genuinely emit one-shot JSON,
but ships with zero default entries — no default entry may claim an
interface its tool does not document.

### Normalization

LSP results normalize into the same `InspectedFile` shape the registry
already merges (`{ path, language, lineCount, imports, symbols }`,
symbols `{ kind, name, lineStart, lineEnd }`):

- `SymbolKind` maps onto the repomap kinds the ranker weights
  (`src/repomap/rank.mjs`): Function/Method → `function`,
  Class/Interface/Struct/Enum → `class`, Variable/Constant/Field →
  `variable`; names matching the existing test heuristics keep kind
  `test`. Unmapped kinds drop rather than invent new kinds — ranking
  weights stay untouched.
- Servers may return hierarchical `DocumentSymbol[]` (with `children`)
  or flat `SymbolInformation[]` depending on capability negotiation; both
  are handled, children flattened.
- LSP positions are 0-based; repomap lines are 1-based. URIs are
  `file://` and must resolve back to workspace-relative paths; results
  outside the workspace root are discarded.

Merged results flow through the existing path: `mergeInspectorResults`
keeps base `contentLines` (ranking and chunk building still need them) and
re-ranks via the repomap public API. References and diagnostics attach to
the index and are recorded in the context artifacts alongside the
phase 97 strategy field, so a replayed run shows what LSP contributed.

### Opt-in gating and trust boundary

- Off by default. `--lsp` enables it for a run; `lsp` in
  `.kodr/config.json` (phase 96) sets the project default, with
  `--no-lsp` as the explicit off switch, following the phase 97 tri-state
  precedent. Resolution and source appear in `--show-config` and
  `summary.json` like every other phase 96 key.
- Config selects servers by registry name only (`true` for all
  registered, or an array of known names). Command strings or args in
  config are rejected loudly, like the phase 96 gate keys: a cloned
  repository's config must never choose what binary kodr executes.
- Enabling LSP can execute repository code — rust-analyzer runs build
  scripts and proc-macros, gopls invokes the go toolchain. That is why
  the default is off and why config-supplied commands are banned;
  usage.md must state the caveat where it documents the flag.
- Model output never reaches the LSP process: the adapter is app-driven
  off the walker's file list; the `inspect_symbols` / `find_references`
  tool calls keep consuming the merged index, not the server.

## What Does Not Change

- A bare run with no `--lsp` and no config key spawns no external
  process — the phase 97 auto-inspection path uses the built-in index
  only. This is a behavior *fix* relative to today's bogus spawns, and
  the regression lock for the phase.
- `src/repomap/` is untouched: no new exports, no LSP imports, boundary
  test still green. The adapter feeds the index from outside, as the
  phase 95 non-goals promised.
- Tool schemas, ranking weights, chunk selection, prompt text, and
  artifact formats.
- Write/exec gating, sandbox, and skill approval. LSP is read-only
  enrichment; it grants nothing.

## Test Requirements

- Framing parser: headers split across chunks, several messages in one
  chunk, oversized and malformed frames rejected without hanging.
- Lifecycle against a fake LSP server — a Node script speaking real
  framed JSON-RPC over stdio, the phase 03 fake-model-server pattern
  applied to LSP: clean handshake/shutdown; a server that never answers
  `initialize` is killed at the timeout and the run falls back with the
  reason recorded (phase 97 `fallbackReason` shape).
- Normalization: `DocumentSymbol[]` with nested children and flat
  `SymbolInformation[]` both produce correct kinds and 1-based lines;
  out-of-workspace URIs are discarded; diagnostics collected within the
  window land in the index and artifacts.
- Merge: LSP-covered files take precedence, base index fills gaps,
  `contentLines` survive, re-ranking runs — extending the existing
  `mergeInspectorResults` tests.
- Gating: default-off spawns nothing (spy on the spawn seam under
  `inspectContext: 'auto'`); `--lsp`, config key, and `--no-lsp` resolve
  with phase 96 precedence; config containing a command string or an
  unknown server name fails naming the offending value.
- Registry hygiene: a test asserts no default `'cli'` entries exist, so
  the invented-flags regression cannot quietly return.

## Non-Goals

- No bundled or auto-installed language servers; discovery only finds
  what the user already has.
- No editor features: completion, hover, rename, code actions,
  formatting, semantic tokens.
- No persistent server daemon across runs and no incremental `didChange`
  sync — spawn, query, shut down, per run.
- No diagnostics-driven healing integration; diagnostics are recorded
  context, and wiring them into the repair loop is a later phase if it
  earns one.
- No new repomap languages, ranking signals, or chunk heuristics.

## Done Criteria

- [ ] `src/lsp-client.mjs` implements framing, lifecycle with timeouts,
      and the four operations using Node builtins only.
- [ ] Registry entries rewritten to documented real invocations with
      `protocol: 'lsp'`; no default `'cli'` entries remain.
- [ ] LSP results normalize into the `InspectedFile` shape and merge
      through the existing registry path with artifacts recording the
      contribution.
- [ ] Off by default with `--lsp` / config / `--no-lsp` resolution
      visible in `--show-config` and `summary.json`; config cannot
      supply commands.
- [ ] Every failure mode (missing server, handshake failure, timeout,
      malformed frames) falls back to the built-in index with the reason
      recorded.
- [ ] Fake LSP server fixture and tests per Test Requirements.
- [ ] One real integration run against a locally installed server,
      recorded in `process/experiments.jsonl`, per the AGENTS.md
      security-boundary rule — or a documented note of which servers
      were unavailable and why fake-server coverage stands in.
- [ ] usage.md documents the flag, the config key, and the
      repository-code-execution caveat.
- [ ] Record decisions and any failures.
- [ ] Blog post.
- [ ] Mark roadmap complete and commit.
