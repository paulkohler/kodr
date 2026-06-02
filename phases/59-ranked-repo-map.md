# Phase 59: Ranked Repo-Map

## Goal

Improve symbol relevance and finally connect the Phase 53 external inspector
registry to the run/packing flow. Today the registry only powers the
`inspect --registry` listing in `app.mjs`; it does not enrich any run.

This closes the biggest capability gap versus Aider's repo-map. Combined with
the Phase 60 budget, better ranking means the most relevant context in the
fewest tokens — exactly what small models need.

## Design

- Add relevance ranking to symbol selection (e.g. reference-count / frequency
  weighting over the regex index) with a documented, deterministic score.
- Let an available registry tool (e.g. tree-sitter) enrich the normalized index
  when present, falling back cleanly to the built-in inspector when not.
- Feed the ranked output into the Phase 60 budget-aware packer.

## Non-Goals

- No requirement to ship a tree-sitter dependency (registry is optional,
  external, detected at runtime).
- No semantic type analysis.

## Done Criteria

- [x] Ranking function orders symbols deterministically by a documented score,
      with tests.
- [x] Registry enrichment path exercised with a fake external command (reuse the
      Phase 53 fake-command tests), with clean built-in fallback.
- [x] Inspection-aware packing consumes the ranked output.
- [x] Record decisions and any failures.
- [x] Blog post.
- [x] Mark roadmap complete and commit.
