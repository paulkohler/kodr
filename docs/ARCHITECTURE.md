# Kodr Architecture — Orientation Map

This is the map a cold session should read first. Kodr is **two products tangled
together**: a lean daily-driver coding agent (call a local model → it edits files
via tools → run commands → verify → apply) and a research harness for studying
how local models behave under that agent. The complexity feeling comes from the
second bleeding into the first — see the proportions below.

Sizes are a snapshot as of phase 223 (kodr 0.0.223): 74 `src/*.mjs` files,
~27,400 lines. Counts are indicative of *proportion*, not exact over time.

## The five tiers

### Tier 1 — CORE: the daily driver (~9.0k lines, ~34%)
The loop: prompt → model → tool-driven edits → run/verify → apply.

| Module | Role |
|---|---|
| `model-client`, `completion` | talk to the local model (HTTP, streaming, continuations) |
| `tool-calls`, `tools` | `write_file`/`edit_file`/`read_file`/`list_files`/`run_command` + permissions; `ProposalDraft` capture |
| `safe-writes`, `git-workspace`, `undo` | apply / diff / revert safely |
| `context-packer` | build the prompt context within budget |
| `json-extractor` | parse the model's proposal envelope *(its R0–R6 repair pile is really Tier 2)* |
| `verification-runner`, `syntax-gate`, `dependency-installer` | make & check generated code |
| `healing` | bounded self-repair after a failed verification |
| `tui` | the terminal chat surface |
| `session-compaction`, `loop-budgets`, `permission-policy`, `structured-output`, `edit-formats` | multi-turn memory, loop control, safety |

### Tier 2 — HARNESS SENSORS: core-adjacent, born from dogfooding (~1.5k, ~5%)
Makes the core survive messy real local-model output. Half core, half research —
**the tier to actively shrink.** `harness`, `post-write-sensor`, `system-env`,
`model-profiles` (incl. context-window discovery), **+ the R0–R6 decode-artifact
repair rules inside `json-extractor`**. Landing generation-params
(temperature / `response_format`) could *delete* code here: fewer malformed
envelopes → fewer repair rules needed.

### Tier 3 — RESEARCH / LEARNING SURFACE: the stated mission (~3.1k, ~12%)
Reads the artifacts the core writes; **never required for a run.**
`forensics` (`kodr why`), `trends`, `eval`+`eval-runner`+`eval-trends`
(`kodr evals`), `bench`, `compare`, `replay`, `routing` (`kodr route`), and the
run archive they read: `run-registry`, `run-history`, `probe-persistence`.

### Tier 4 — ADVANCED CAPABILITIES: optional power features (~7.0k, ~26%)
Everything beyond "chat + edit + run." All opt-in.
- **Multi-agent / planning:** `orchestration`, `subagents`, `agents`, `task-plan`, `model-specs`, `workflow`, `cycles`
- **Sandboxes:** `openshell-executor`, `openshell-worker`, `docker-executor`, `active-executor`
- **External integrations:** `lsp-client`, `mcp-client`, `external-inspector-registry`, `inspection-output`
- **Skills:** `skills`, `skill-execution`, `builtin-skills` (role / `lang:` / `model:` skills under `src/builtin-skills/`)
- **Surfaces:** `server` (`kodr serve`), `watcher` (`kodr watch`), `command-hooks`, `hooks`, `memory`

### Tier 5 — INFRA / UTIL (~0.6k, ~2%)
`project-config`, `usage-normalizer`, `ansi`, `progress`, `artifacts`,
`install-local`, `version`, `prompt-id`.

## Cross-cutting: the CLI entry (`app.mjs` + split-out modules)
Phase 148 split the old 5,800-line `app.mjs` god-file along tier lines (pure,
behavior-preserving, guarded by the test suite + an export-surface guard test).
The layout now:
- `app.mjs` (~500 lines) — the thin entry point: `main()`'s command dispatch,
  `handleChannelRequest` (the channel), `listSessions`, the CLI approver/progress
  helpers, and a **re-export barrel** preserving the public import surface.
- `cli/args.mjs` — `parseArgs`, `assignValue`, option validators, `usage` help
  text. `cli/defaults.mjs` — default constants. `cli/options.mjs` — shared input
  helpers (`loadPrompt`, `workspaceContextOptions`, `resolved{Skills,Agents}Dirs`).
- `commands/*.mjs` — one module per leaf subcommand (forensics, inspect, replay,
  session, bench, serve, compare, probe, skills, init, eval). Handlers that need
  the channel or `runPrompt` take them as injected params (extraction stays
  one-directional — no module imports `app.mjs`).
- `run-pipeline.mjs` (~3,330 lines) — the Tier-1 core: `runPrompt`,
  `runStagedPrompt`, and ~35 private helpers (context discovery, executor init,
  the run/tool loop, healing, writes, summary, `maybeCommitAppliedWrites`).
- `render.mjs` — pure CLI renderers. `cli-errors.mjs` — `CliError` /
  `NativeNoProposalError`. `parseManagementInstances` now lives in
  `model-profiles.mjs`.

Tier 4 now lazy-loads off these seams (phase 149, lever #2): a bare
`run`/`chat`/`tui` does not statically import orchestration, the Docker/OpenShell
sandboxes, LSP, MCP, or the web server. The static import graph reachable from
`app.mjs` dropped **84 → 59 modules**. Each capability loads via a dynamic
`import()` behind its flag/command:
- `app.mjs` `main()` dynamic-imports each `commands/*` handler in its dispatch
  branch → drops every command module + `server` (serve) + `subagents` (replay) +
  the inspect→`external-inspector-registry`→`lsp-client` path.
- `run-pipeline.mjs` dynamic-imports `orchestration` (`--subagent-stages`),
  `openshell-worker` (worker mode), `external-inspector-registry` (inspection).
- `active-executor.createActiveExecutor` (now async) dynamic-imports the
  Docker/OpenShell backend only when its flag is set; the pure option helpers live
  in light `sandbox-options.mjs` so `parseArgs` stays sandbox-free.
- `post-write-sensor` dynamic-imports the registry + LSP only under `--lsp`;
  `tools.mjs` builds the MCP client lazily on first `mcp:` call.
A guard test (`test/lazy-load.test.mjs`) pins the bare-run graph so a future
static import cannot quietly drag a Tier-4 module back onto the hot path.

## The takeaway

The research mission you set is only **~12%** of the code. The "too much" feeling
was **Tier 4 (~26%, optional power features)** plus the **`app.mjs` god-file
(~22%)**. The simple tool — Tier 1 + infra — is **~36%** and is intact and
working.

Levers to recover "simple" as a felt experience, in order:
1. ~~**Split `app.mjs`** along tier lines~~ — **done (phase 148):** 5,806 → ~500
   lines, dispatcher + `commands/*` + `cli/*` + `run-pipeline.mjs`, zero behavior
   change. This was the biggest legibility win and it created the seams for #2.
2. ~~**Make Tier 4 opt-in / lazy**~~ — **done (phase 149):** a bare `run`/`chat`/
   `tui` no longer statically loads orchestration, Docker/OpenShell, LSP, MCP, or
   the web server; static graph from `app.mjs` 84 → 59 modules, guarded by
   `test/lazy-load.test.mjs`. See the cross-cutting section above.
3. **Shrink Tier 2** once generation-params land — delete repair rules rather than add them.
4. **Leave Tier 3 alone** — it's small and it's the point of the project.

## Where else to look
- `roadmap.md` — phase progress. `NEXT.md` — forward candidates (loose, FIFO).
- `process/decisions.jsonl`, `process/failures.jsonl` — why things are the way they are; real failure forensics.
- `blog/` — narrative of important harness/app failures per phase.
- `AGENTS.md` (repo root `CLAUDE.md`) — the constitution and the Required Loop.
