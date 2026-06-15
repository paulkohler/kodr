# Phase 149 — Lazy-Load Tier-4 Capabilities

## Motivation

Lever #2 from the architecture review (`docs/ARCHITECTURE.md`): a bare `run`/`chat`
invocation should not load orchestration, sandboxes (Docker/OpenShell), LSP, MCP,
or the web server. Phase 148 split `app.mjs` and created the seams; this phase
hangs the lazy-loading off them.

Measured before this phase: the static import graph reachable from `app.mjs` is
**84 `src/` modules**, and almost every heavy Tier-4 module is on it —
`orchestration`, `subagents`, `docker-executor`, `openshell-executor`,
`openshell-worker`, `external-inspector-registry`, `lsp-client`, `mcp-client`,
and `server` all load on a bare `kodr run` even though none of them runs unless a
specific flag/command asks for it. (`watcher` was already lazy.) None of these is
on the actual hot path: each is gated behind a flag (`--subagent-stages`,
`--docker-sandbox`, `--openshell-*`, `--lsp`, MCP providers) or a non-`run`
command (`serve`, `watch`, `replay`, `inspect`).

This is a **behavior-preserving** change: convert the static `import` at each seam
into a dynamic `import()` performed only on the path that already gates the
feature. No logic, output, or flag changes.

## Scope — what becomes lazy, and what stays core

Two layers:

**Layer 1 — lazy command dispatch (`app.mjs`).** `main()` statically imports all
11 leaf command handlers (`commands/*`). Move each to a dynamic `import()` inside
its `if (options.command === 'X')` branch (`main()` is already async). This single
change drops every command module — and with them `server` (via `commands/serve`),
`subagents` (via `commands/replay`), and the `commands/inspect → external-inspector-registry → lsp-client` path — off the bare-run static graph. `run`/`chat`/`tui`
stay on the static path because `runPrompt` lives in `run-pipeline.mjs`, imported
directly (it is the core, not a command module).

**Layer 2 — lazy deep seams reached through *core* modules.** These are not behind
a command, so dispatch laziness does not cover them:
- `run-pipeline.mjs` → `orchestration` (`runSubagentStages`), `openshell-worker`
  (`runOpenShellWorker`), `external-inspector-registry` (`inspectWithRegistry`).
  All three call sites are already `await`-ed → dynamic `import()` is a drop-in.
- `active-executor.mjs` → `docker-executor` / `openshell-executor`. Gate the
  backend imports on `options.dockerSandbox` / `options.openshellSandbox`.
  `createActiveExecutor` becomes **async** (dynamic import cannot be synchronous);
  two call sites add `await`.
- `cli/args.mjs` → `docker-executor` / `openshell-executor` for option
  validators/defaults. `parseArgs` is synchronous and widely called sync in tests,
  so it cannot use dynamic `import()`. Instead extract the pure helpers
  (`dockerDefaults`, `validateDockerOptions`, `openshellDefaults`,
  `validateOpenShellOptions`, the two `*SandboxError` classes, `isAllowedNetwork`,
  the default constants) into a new light `src/sandbox-options.mjs` (no
  `node:child_process`). `cli/args.mjs` imports from there; the executor modules
  import the defaults back and **re-export** the helpers so existing importers
  (tests, `openshell-worker`) are unchanged.
- `post-write-sensor.mjs` → `external-inspector-registry` + `lsp-client`. It uses
  `REGISTRY` as a default parameter (load-time). Switch the default to `null` and
  resolve `REGISTRY`/`discoverInspectors`/`runLspInspector` via dynamic `import()`
  inside the `options.lsp`-enabled path.
- `tools.mjs` → `mcp-client`. The `ToolRunner` constructor eagerly builds an MCP
  client. Defer it: store providers, create the client lazily via an async getter
  on the first `mcp:`/`list_mcp_tools` call.

**Stays core (out of scope).** `task-plan` (`createTaskPlan` runs on every run),
`agents` (persona/role discovery on every run), `builtin-skills` (via
`system-env`), and `skill-execution` (via `tool-calls`) are reached through
genuinely core modules and run unconditionally. They carry a Tier-4 label in the
map but are part of the daily-driver loop; lazy-loading them would be a behavior
change, not a no-op. Left as-is, noted here so the omission is deliberate.

## Behavior-change caveat (honest note)

`createActiveExecutor` changes from a synchronous to an `async` function. This is a
real (if tiny) interface change, not a pure re-export. Its direct unit test
(`test/active-executor.test.mjs`) calls it synchronously in three assertions;
those three lines gain `await` and the test fn becomes `async`. The assertions and
their intent are otherwise unchanged. This is the only test edit in the phase and
is recorded in `process/decisions.jsonl`.

## Work items (small commits; suite green after each)

1. Extract `src/sandbox-options.mjs`; repoint `cli/args.mjs`; re-export from the
   executor modules.
2. Lazy sandbox backends: async `createActiveExecutor`, `await` both call sites,
   update the 3 test assertions.
3. Lazy `mcp-client` in `tools.mjs`.
4. Lazy `orchestration` / `openshell-worker` / `external-inspector-registry` in
   `run-pipeline.mjs`.
5. Lazy `external-inspector-registry` / `lsp-client` in `post-write-sensor.mjs`.
6. Lazy command dispatch in `app.mjs`.
7. Guard test `test/lazy-load.test.mjs`: static-graph traversal from `app.mjs`
   asserting the heavy modules are NOT statically reachable and the core ones are.

## Testing

- `npm test` after every commit — full suite is the behavior oracle.
- `npm run check` + `npm run format` each commit.
- New guard test locks the win and fails loudly if a future static `import` drags a
  Tier-4 module back onto the bare-run path (the phase-148 export-guard pattern,
  applied to the import graph instead of the export surface).

## Done criteria

- [x] Bare-run static import graph from `app.mjs` excludes `orchestration`,
      `subagents`, `docker-executor`, `openshell-executor`, `openshell-worker`,
      `external-inspector-registry`, `lsp-client`, `mcp-client`, `server`,
      `watcher`. Measured: **84 → 59 modules** reachable from `app.mjs`.
- [x] Each lazy module still loads and works behind its flag/command — covered by
      the existing suite (no feature tests removed; orchestration / sandbox / lsp /
      mcp / server / watcher suites all green) + a live CLI smoke check dispatching
      `skills`, `inspect`, `why`, `registry`, `trends`, `route` through the real
      binary (every dynamic `import()` path resolved; no module-not-found).
- [x] Full suite green (1,447 = 1,431 + 16 guard); the only feature-test change is
      the 3-line `await` in `test/active-executor.test.mjs` (signature change),
      recorded in decisions.
- [x] `npm run check` + `npm run format` green.
- [x] Guard test `test/lazy-load.test.mjs` added and green.
- [x] `docs/ARCHITECTURE.md` lever #2 marked done; module-count before/after noted.
- [x] `process/decisions.jsonl` + `process/failures.jsonl` updated.
- [x] Blog post `blog/149-lazy-tier4.md`.
- [x] Roadmap line checked; version bumped to 0.0.149.
