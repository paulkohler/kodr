# Phase 62: Inspector Tool Calls

Phase 62 gives tool-mode runs a structural way to look around before reading
raw files. Kodr already had `list_files`, `read_file`, and `run_command`. That
was enough for simple tasks, but it forced the model to read whole files just to
answer basic questions like "what functions are in this repo?" or "where is
this symbol referenced?"

The new tools are deliberately small:

- `inspect_symbols` returns compact symbol records with path, name, kind, and
  line range;
- `find_references` returns compact references for a named symbol.

There is no `inspect_file` tool. That would overlap with `read_file`, and small
local models already struggle when two tools sound like they do the same thing.
The split is now clear: use `inspect_symbols` for structure, `find_references`
for usage, and `read_file` for source text.

Both tools are read-only and workspace-jailed. They also cap the number of
returned entries and cap serialized output around 8 KB. If a result still gets
too large after count limits, Kodr truncates it and appends an explicit marker
instead of letting a tool call flood the next model turn.

The system prompt now names the structural tools alongside `read_file` and
`run_command`. Subagent implementers inherit that guidance through the standard
tool-list rendering, so the exact available tool names stay visible in isolated
stage prompts.

The useful lesson here is that tool shape is part of model behavior. Adding a
new verb is cheap in code, but every overlapping verb makes a small local model
less decisive. This phase keeps the navigation surface narrow enough to be
useful without turning tool choice into another planning problem.
