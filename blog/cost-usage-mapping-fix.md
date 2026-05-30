# Cost Usage Mapping Fix

I added `--max-cost-usd` as part of loop budgets before wiring provider cost
usage correctly. The flag parsed and the budget machinery could enforce a
`costUsd` value, but there was no pricing table and no provider adapter mapping
OpenRouter's documented `usage.cost` field into that internal value.

That meant the option was technically present but mostly inert. Local providers
such as LM Studio do not charge per request, so they should report zero cost.
OpenRouter does report account cost, but under the field name `cost`, not
`costUsd`.

The fix is provider normalization:

- local providers map cost to `0`
- OpenRouter maps `usage.cost` to Kodr's `cost` and legacy `costUsd` fields
- unmapped future providers must not silently accept `--max-cost-usd`

This is a good example of why provider-shaped metadata should live behind an
adapter. Token usage looked OpenAI-compatible enough to pass through directly,
but cost was not actually portable. The next model-profile phase should keep
that distinction explicit: provider capability metadata belongs in one place,
not scattered through CLI help text and loop-budget accounting.
