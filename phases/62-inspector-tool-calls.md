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

- [ ] Add `inspect_symbols` and `find_references` to the built-in tool registry.
- [ ] Return compact, bounded JSON results (caps above, with truncation marker).
- [ ] Enforce workspace jails and the documented output limits.
- [ ] Add tests for each tool, including a truncation/over-limit case.
- [ ] Add system-prompt guidance naming the inspector tools, with a test
      asserting the guidance is present.
- [ ] Record decisions and any failures.
- [ ] Blog post.
- [ ] Mark roadmap complete and commit.
