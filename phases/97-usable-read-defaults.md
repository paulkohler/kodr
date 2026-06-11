# Phase 97: Usable Read Defaults

## Summary

Turn on by default the paths that are read-only or already bounded, so a
bare `kodr run -p "task"` behaves like a coding harness instead of a demo:
tools resolve from the model profile, interactive runs stream, inspection-
aware packing is the default context strategy, and `--yes --test` runs
heal. Write gating does not change: dry-run before writes stays the
constitution, and every new default gets an explicit off switch.

## Motivation

- The doc review that motivated phase 96 found the realistic daily
  invocation was `--tools --yes --install --test "npm test" --heal
  --stream`. Phase 96 lets a project record those choices in
  `.kodr/config.json`; this phase fixes the shipped defaults so a project
  without a config is still usable. Config should express preference, not
  be the escape hatch from demo mode.
- The safety story already lives per-effect, not on the flags. In the
  builtin registry (`createBuiltinRegistry`, `src/tool-calls.mjs`),
  `list_files`, `read_file`, `inspect_symbols`, `find_references`, and
  `read_skill_resource` are jailed read-only lookups; `run_command` only
  reaches `runVerification`'s command allowlist; `run_skill_command`
  requires explicit approval plus a sandbox executor. Keeping the whole
  registry behind `--tools` guards nothing — it just ships the worse
  default and trains users to paste the same six flags forever.
- Off-by-default read paths also distort the learning record: examples and
  blog runs generated without tools, streaming, or inspection context do
  not exercise the code paths a real user hits, so regressions in those
  paths surface late.

## Design

Flag shape: `tools`, `stream`, `heal`, and `inspectContext` move from
plain `false` booleans in `parseArgs` (`src/app.mjs`) to the tri-state
`'auto' | true | false` pattern `staged` already uses. Each gains a
negative flag following the existing `--no-review` precedent:
`--no-tools`, `--no-stream`, `--no-heal`, `--no-inspect-context`. The
positive flags keep forcing true. Precedence follows phase 96: explicit
flags beat project config, which beats the auto resolution below, and the
resolved value plus its source shows up in `--show-config` and
`summary.json`.

Per-default resolution:

- Tools: `auto` resolves in `applyModelProfileDefaults()`
  (`src/model-profiles.mjs`) from the resolved profile's
  `nativeToolCalls` field — today that field is copied onto options and
  consumed by nothing, so this gives it its first real consumer. All
  builtin profiles set it true; a `.kodr/model-profiles.json` entry with
  `nativeToolCalls: false` keeps tools off for envelope-only models.
  Auto resolution applies to the run-turn paths (CLI `run`, TUI, serve
  turns); `compare` and `eval` keep explicit flags so suite scores stay
  comparable across phases. `--subagent-stages` still implies tools.
- Stream: `auto` resolves on when `io.stdout.isTTY` is true and `--json`
  is not set. Today only the TUI renders chunks (`src/tui.mjs` sets
  `options.onStreamContent`; `src/model-client.mjs` switches the request
  to SSE whenever `options.stream` is truthy) — a one-shot
  `kodr run --stream` changes transport with nothing visible. The phase
  wires an `onStreamContent` renderer for interactive one-shot runs so
  the default is observable, and keeps `kodr serve` forcing
  `stream: false` in `buildTurnOptions` (`src/server.mjs`).
- Inspection-aware packing: `createInspectionContext` (`src/app.mjs`)
  currently gates on the `--inspect-context` flag; `auto` enables it
  whenever the repomap index builds successfully
  (`inspectWithRegistry`, `src/external-inspector-registry.mjs`, over
  phase 95's `src/repomap/`), falling back to whole-file packing when
  index construction throws. Interaction to get right: when tools are
  on, `buildWorkspaceContext`'s `toolsMode` branch
  (`src/context-packer.mjs`) returns AGENTS.md plus the file map and
  never reaches the inspection branch — so for tools-on runs this
  default contributes the inspection task plan prepended to the prompt
  (`createInspectionTaskPlan`), while packed inspection chunks apply to
  tools-off runs. The context artifacts record which strategy ran
  (`inspection-aware`, file-map, or whole-file) and the fallback reason
  when the index failed.
- Heal: `auto` resolves on when both `--yes` and `--test` are present.
  The gate in `runHealingIfNeeded` (`src/app.mjs`) already requires
  `heal && yes && testResult && !testResult.ok` and clamps the repair
  loop's turns and retries, so the default only adds the bounded repair
  pass to runs that already asked for apply-and-verify.

Surfaces that read these options keep working with resolved values, never
`'auto'`: TUI state seeds `tools` from options (`createTuiState`,
`src/tui.mjs`) and `/tools` still toggles per-session; the OpenShell
worker run script serializes `tools` and `heal` flags
(`src/openshell-worker.mjs`); HTTP run submission keeps its explicit
boolean fields.

## What Does Not Change

- `--yes`, `--install`, `--commit`, sandbox flags, skill command
  approval, and the permission policy. Dry-run stays the default
  everywhere; HTTP turns stay dry-run and loopback-only.
- The tool registry: no new tools, no schema changes, no allowlist
  widening.
- `--subagent-stages` stays opt-in (expensive, model-dependent).
- Default model, base URL, and timeout resolution.

## Test Requirements

- Tools resolution: `auto` with a tool-capable profile resolves on; a
  profile with `nativeToolCalls: false` resolves off; `--tools` and
  `--no-tools` beat both profile and project config; `compare` and
  `eval` are unaffected by auto.
- Stream: an interactive TTY one-shot run renders streamed chunks;
  non-TTY and `--json` runs stay non-streamed; `--no-stream` forces off;
  server turn options still force `stream: false`.
- Packing: index success records the inspection-aware strategy; a forced
  index failure falls back to whole-file packing with the reason
  recorded; tools-on runs keep the file-map packing branch unchanged.
- Heal: `--yes --test` heals on a failing test without the flag;
  `--no-heal` and dry-run runs never invoke healing.
- Gate regression: a bare `kodr run -p` with default-on tools performs no
  writes and no unapproved command execution — asserted through the
  channel-contract tests, not only unit mocks.

## Non-Goals

- No change to write/exec gating, sandbox behavior, or skill command
  approval semantics.
- No streaming for `--json` output or new server SSE behavior.
- No new tool registrations or context-packing heuristics.
- No global user-level config (phase 96 scoped that out already).

## Done Criteria

- [x] `tools`, `stream`, `heal`, and `inspectContext` are tri-state with
      `--no-*` escapes and phase 96 config precedence, visible in
      `--show-config` and `summary.json`.
- [x] Tools default resolves per model profile with both overrides
      tested; `compare`/`eval` unaffected.
- [x] Stream defaults on for interactive TTY only, with a chunk renderer
      for one-shot runs; server turns unchanged.
- [x] Inspect-context is the default packing strategy with recorded
      fallback; tools-on file-map packing unchanged.
- [x] Heal defaults on for `--yes` + `--test` runs.
- [x] Write/exec gates verified unchanged by tests.
- [x] usage.md Safety Defaults section and README examples state the new
      defaults and the unchanged write gates.
- [x] Record decisions and any failures.
- [x] Blog post.
- [x] Mark roadmap complete and commit.
