# Kodr Architecture — Orientation Map

This is the map a cold session should read first. Kodr is **two products tangled
together**: a lean daily-driver coding agent (call a local model → it edits files
via tools → run commands → verify → apply) and a research harness for studying
how local models behave under that agent. The complexity feeling comes from the
second bleeding into the first — see the proportions below.

Sizes are a snapshot as of phase 147 (kodr 0.0.147): 67 `src/*.mjs` files,
~26,600 lines. Counts are indicative of *proportion*, not exact over time.

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

## Cross-cutting: `app.mjs` (~5,800 lines, ~22%)
The CLI dispatcher + the core run pipeline, welded together. It touches **every
tier**, which is why it feels heavy. Anatomy:
- `parseArgs`, `usage` — arg parsing & help text
- `main()` — a long `if (command === 'X')` chain dispatching ~22 subcommands
- `runPrompt` (~2,800 lines) — the Tier-1 core pipeline (context discovery,
  executor init, the run/tool loop, healing, writes, summary)
- `handleChannelRequest`, `parseManagementInstances`, `renderSession*`,
  `renderSkillsListing`, `extractPromptFilePaths`

Splitting it (phase 148) is the single highest-leverage cleanup — purely
behavior-preserving, guarded by the test suite.

## The takeaway

The research mission you set is only **~12%** of the code. The "too much" feeling
is **Tier 4 (~26%, optional power features)** plus the **`app.mjs` god-file
(~22%)**. The simple tool — Tier 1 + infra — is **~36%** and is intact and
working.

Levers to recover "simple" as a felt experience, in order:
1. **Split `app.mjs`** along tier lines (phase 148) — biggest legibility win, zero behavior change.
2. **Make Tier 4 opt-in / lazy** — a `run`/`chat` invocation shouldn't load orchestration, Docker, LSP, MCP, or the web server.
3. **Shrink Tier 2** once generation-params land — delete repair rules rather than add them.
4. **Leave Tier 3 alone** — it's small and it's the point of the project.

## Where else to look
- `roadmap.md` — phase progress. `NEXT.md` — forward candidates (loose, FIFO).
- `process/decisions.jsonl`, `process/failures.jsonl` — why things are the way they are; real failure forensics.
- `blog/` — narrative of important harness/app failures per phase.
- `AGENTS.md` (repo root `CLAUDE.md`) — the constitution and the Required Loop.
