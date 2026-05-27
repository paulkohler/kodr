# Phase 31: Local Markdown Search Example

The fifth generated example is a local Markdown search app. It indexes `.md` files, parses frontmatter titles and headings, ranks results by title, heading, and body matches, emits snippets, and exposes a small CLI.

This example was useful because it looked simple but stressed the repair path. The scaffold and core search implementation were generated through Kodr runs, then the example moved through smaller repair prompts. Those runs found two real safe-write bugs:

- A failed patch batch could partially apply earlier patches before a later stale patch failed.
- Several patches targeting the same file could overwrite each other because each patch was computed from the original content.

Kodr now validates a patch batch before writing and composes same-file patches in memory before touching disk. That keeps failed repairs inspectable without leaving the workspace in a half-applied state.

The final repair run also showed a model-quality issue rather than a harness crash. The model had the right intent, but it used placeholder anchors and stale indentation in patch search strings. Safe writes rejected the proposal with no writes, and the artifact remained available for inspection. The example was then manually stabilized using that narrow proposal intent.

The tests now cover indexing, ranking weights, snippet extraction, CLI output, and prompt-injection-like Markdown content. The injection text is treated as searchable document data only; it is not promoted into instructions.

The cycle review also surfaced a process gap: the repo instructions implied examples should be documented, but did not explicitly say examples are Kodr samples with provenance or that blog posts should capture important harness failures. Those general rules were promoted into `AGENTS.md`; phase-specific directions stayed in the roadmap.

The next phase, loop budgets, still holds. This example produced long local-model waits and a timeout, which is exactly the pressure a budget layer should make visible.
