# Phase 41: Token Usage Reporting

Loop budgets have tracked token totals since phase 33, and phase 39 made the
streaming path capture usage too. But none of it was visible: `summary.json`
carried the raw `loopBudget` snapshot, the CLI said `Tokens: 711`, and
`prompt-history` showed nothing at all. Phase 41 makes usage a first-class field
everywhere a user actually looks.

## What changed

**`loop-budgets.mjs`** — `recordUsage` now accumulates `promptTokens` and
`completionTokens` alongside the existing `tokens` total. The snapshot includes
both. The budget already deducted totals against `maxTokens`; the split is
carried for display, not for budget enforcement.

**`summary.json`** — gains a structured `usage` field sourced from the loop
budget on every successful run:

```json
"usage": {
  "tokens": 1234,
  "promptTokens": 900,
  "completionTokens": 334,
  "costUsd": 0.0021
}
```

Returns `null` (not a zero-filled object) when the server sent no usage data.
Null is the unambiguous "no data" signal; a zero-filled object would look like
the run actually used zero tokens. Failed runs also write `"usage": null` so the
field is always present and consumers don't have to check for its absence.

**`kodr run` non-JSON output** — the token line is now a proper breakdown:

```
Tokens: 1,234 (prompt 900 / completion 334)  Cost: $0.0021
```

The prompt/completion split only prints when both are non-zero (i.e. when the
server supplied the breakdown). If the server only sends a total, just the total
appears. If the server sends nothing, the line is omitted entirely.

**`kodr prompt-history`** — each run line now includes `tokens=N` when the
stored usage is non-zero:

```
2026-05-29T10:00:00.000Z  qwen/qwen3.6-35b-a3b  [ok]  tokens=7252
```

`scanRunHistory` reads `summary.usage.tokens` and passes it through; old run
dirs without a `usage` field default to `0` and show nothing.

## Design notes

The field is `usage` rather than embedding the breakdown in `loopBudget`
directly, because `loopBudget` is the enforcement snapshot (turns, retries, max
thresholds) while `usage` is the reporting field. They're related but serve
different purposes and shouldn't share a shape.

Null vs zero: several tests and the prompt-history formatter needed to
distinguish "server omitted usage" from "actually zero". Null is the right
sentinel — it's structurally different from `{ tokens: 0, ... }` and can be
checked with a simple `if (usage)`.
