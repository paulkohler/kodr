# Phase 61: Token-Budget-Aware Context Assembly

Phase 61 turns model context limits into an input to packing rather than a
background assumption. Phase 69 made context windows and completion reserves
explicit in model profiles; this phase uses those values when assembling the
workspace context.

The first implementation target is inspection-aware packing. Kodr already knows
how to build structural chunks around matching symbols and related files, but it
previously accepted the selected chunks as if every model could afford them.
That is exactly where small local models become brittle: the context looks
helpful, but it steals the completion room needed to actually finish the task.

The packer now computes a deterministic budget:

- active context window from the model profile or `--context-window`;
- completion reserve from the profile or `--completion-reserve`;
- an approximate four characters per token conversion;
- an existing hard character cap so legacy runs do not suddenly balloon.

Inspection chunks are selected in ranked order until the budget is full. If the
first chunk alone is too large, Kodr truncates it instead of emitting nothing.
Everything else over budget is counted as dropped context and surfaced in the
rendered context summary. Run summaries now also carry the context budget block,
so failed runs can show whether the model was starved, over-packed, or simply
working with a small profile.

The CLI gained explicit overrides for cases where the serving layer differs
from the built-in profile:

```sh
kodr run -p "Inspect this API" \
  --context-window 65536 \
  --completion-reserve 4096
```

The important design choice is that budgeting is deterministic. There is no
model call deciding relevance and no hidden provider behavior in the packer.
That keeps the feature testable and keeps local-model runs reproducible.
