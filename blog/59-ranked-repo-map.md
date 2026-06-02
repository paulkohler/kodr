# Phase 59: Ranked Repo-Map

Phase 59 adds a deterministic ranked repo-map for inspection-aware context.

The ranking is intentionally lexical. Kodr does not need a semantic model or a
new parser dependency to make better context choices. Each symbol gets a score
from:

- query match strength
- lexical reference count
- symbol kind weight
- deterministic path, line, and name tie-breakers

The result is exposed as `rankedSymbols` on inspection indexes. Existing
`symbols` consumers continue to work, but context packing can now iterate the
ranked list and include more relevant chunks first.

This phase also connects the external inspector registry to run context. When
`--inspect-context` builds an index, Kodr now uses the registry enrichment path.
If a registered external tool is present and returns normalized file data, that
data replaces the built-in result for those files. If tools are missing or fail,
Kodr falls back to the built-in inspector.

The important constraint is predictability. The ranked repo-map is not trying
to be clever; it is trying to be stable, cheap, and good enough to put likely
target code before noise for small local models.
