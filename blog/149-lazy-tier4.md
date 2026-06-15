# Phase 149: Making Tier-4 Capabilities Lazy-Load

The architecture review's second lever (after splitting `app.mjs` in phase 148):
a bare `kodr run`/`chat`/`tui` should not load the optional power features —
orchestration/subagents, the Docker and OpenShell sandboxes, the LSP and MCP
integrations, or the web server. None of them runs unless a flag or a non-`run`
command asks for it, yet all of them were imported the moment the CLI started.

Measured first, as always. A small static-import-graph traversal from `app.mjs`
(parsing `import …/export … from '…'`, ignoring dynamic `import()`):

```
STATIC modules reachable from app.mjs: 84
  YES orchestration   YES docker-executor   YES openshell-executor
  YES openshell-worker YES external-inspector-registry YES lsp-client
  YES mcp-client       YES server            YES subagents
```

Nine heavy modules on the hot path, none of them needed for the common case.
After this phase: **59 modules**, all nine gone.

## Two layers

**Layer 1 — lazy command dispatch (one file).** `main()` statically imported all
11 leaf command handlers. Moving each to a dynamic `import()` inside its
`if (options.command === 'X')` branch (`main()` is already async) drops every
`commands/*` module off the bare-run graph — and with them `server` (reached via
`commands/serve`), `subagents` (via `commands/replay`), and the
`commands/inspect → external-inspector-registry → lsp-client` chain. `run` itself
stays static because `runPrompt` lives in `run-pipeline.mjs` (the core), imported
directly. One edit, a quarter of the graph gone.

**Layer 2 — the seams reached through *core* modules.** These aren't behind a
command, so dispatch laziness doesn't cover them:
- `run-pipeline.mjs` → `orchestration` / `openshell-worker` /
  `external-inspector-registry`. All three call sites were already `await`-ed, so
  this was a drop-in `const { x } = await import('./x.mjs')`.
- `active-executor.createActiveExecutor` → the Docker/OpenShell backends, gated on
  their flags.
- `cli/args.mjs` → the sandbox option validators.
- `post-write-sensor.mjs` → the inspector registry + LSP.
- `tools.mjs` → the MCP client.

## Three things worth writing down

**A default parameter can pin a static import.** `post-write-sensor` had
`async function inspectChangedFiles(cwd, paths, options = {}, registry = REGISTRY)`.
That `= REGISTRY` looks innocent, but the name `REGISTRY` is a module-scope
binding — its presence *requires* the static `import { REGISTRY } from
'./external-inspector-registry.mjs'`, which drags in `lsp-client` too, on every
run, even though the function returns at `if (!options.lsp) return null` two lines
in. The fix: change the default to `registry` (undefined) and resolve
`registry ?? REGISTRY` after the guard, importing `REGISTRY` dynamically there.
Lazy-loading isn't just about call sites; a default-value reference counts.

**Sync factories don't go lazy for free.** `createActiveExecutor` was synchronous:
`createOpenShellExecutor(...) || createDockerExecutor(...)`. Dynamic `import()`
returns a promise, so making the backends lazy forced the function to become
`async`. That rippled to two call sites (both already in async functions, easy)
and — unavoidably — to its direct unit test, which asserted on the synchronous
return value. Three lines gained `await`. Unlike phase 148's pure re-export
refactor, this is a real (if tiny) interface change, and the honest thing is to
edit the test and say so, not to contort the code to keep a sync signature.

**Separate the light abstraction from the heavy implementation.**
`active-executor.mjs` is 50 lines of null-safe glue (`executorCommandRunner`,
`finalizeExecutor`, artifact writers) that run on *every* execution, plus the one
factory that builds a sandbox. The glue is cheap and stays statically imported;
only the factory's two backends (`node:child_process` + hundreds of lines of
sandbox machinery) needed to go lazy. Likewise, the pure Docker/OpenShell *option*
helpers (`validateDockerOptions`, `dockerDefaults`, …) moved to a new light
`sandbox-options.mjs` so synchronous `parseArgs` can validate `--docker-*` flags
without importing the executor at all. The executor modules import the defaults
back and re-export the helpers, so tests and `openshell-worker` are unchanged.

## What stays eager (on purpose)

`task-plan`, `agents`, `builtin-skills`, and `skill-execution` carry a Tier-4
label on the map but are reached through genuinely core modules and run on every
turn (a plan is built, the active persona is discovered, environment facts are
captured). Lazy-loading them would be a behavior change, not a no-op, so they stay
— the guard test asserts the *named* heavy modules are absent, not that the graph
is minimal.

## The guard

`test/lazy-load.test.mjs` runs the same static traversal and asserts the nine
heavy modules are not reachable from `app.mjs`, that the core modules still are,
and that the graph stays well under its old size. It's the import-graph analogue
of phase 148's export-surface guard: a future `import` that quietly puts Docker or
MCP back on the hot path fails CI loudly instead of regressing startup silently.

Full suite stayed green (1,447 incl. the guard) across nine small commits;
`npm run check`/`format` clean throughout; a live CLI smoke check confirmed every
dynamic-`import()` path string resolves at runtime (the unit tests import the
handlers directly, so they wouldn't have caught a typo'd module path).
