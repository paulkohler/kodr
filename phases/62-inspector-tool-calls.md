# Phase 62: Inspector Tool Calls

## Goal

Expose code inspection as bounded model tools so tool-mode runs can navigate a
workspace structurally before editing.

## Design

Add a small, focused set of read-only tools backed by the existing structural
index (`src/code-inspector.mjs`: `inspectWorkspace`, `inspectFile`,
`findReferences`). Keep the surface deliberately tiny: small local models
forget to call tools and pick the wrong one when choices overlap, so two clear
tools beat four ambiguous ones.

- `inspect_symbols` — list symbols for the workspace, or for a single file when
  a `path` arg is given. Returns name, kind, and line range only.
- `find_references` — find references to a named symbol across the index.

Explicitly do **not** add an `inspect_file` raw-text tool: that overlaps with the
existing built-in `read_file` (`src/tool-calls.mjs`) and would confuse small
models. `inspect_symbols` returns the *structural* view (symbols + line ranges);
`read_file` returns raw text. Drop the previously-considered `inspect_context`
tool — it re-exposes the heavy Phase 52 context blob and fights the token
budget.

These tools consume the same normalized inspection index as the ranked repo-map.
They do not add any new external inspector behavior in this phase.

## Bounds

- Cap results at 200 symbols / 100 references per call.
- Cap serialized JSON at ~8 KB; append an explicit `"...truncated"` marker when
  exceeded.
- Jail all paths to the workspace.

## Non-Goals

- No write tools in this phase.
- No external inspector registry dependency.
- No automatic model context replacement.

## Done Criteria

- [x] Add `inspect_symbols` and `find_references` to the built-in tool registry.
- [x] Return compact, bounded JSON results (caps above, with truncation marker).
- [x] Enforce workspace jails and the documented output limits.
- [x] Add tests for each tool, including a truncation/over-limit case.
- [x] Add system-prompt guidance naming the inspector tools, with a test
      asserting the guidance is present.
- [x] Record decisions and any failures.
- [x] Blog post.
- [x] Mark roadmap complete and commit.

## Result

The built-in tool registry now includes `inspect_symbols` and `find_references`
alongside `list_files`, `read_file`, and `run_command`. The new tools are
read-only, workspace-jailed, count-capped, and byte-capped. Tool-mode prompts now
name the structural tools explicitly so models can choose `inspect_symbols` for
structure and `read_file` for raw text.
