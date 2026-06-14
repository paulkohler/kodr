# Phase 146: Stop Wasting Your Context Window

If you're running devstral at 131 K tokens or qwen at 262 K, kodr was silently
treating both as 32 K. Static model profiles hardcoded conservative defaults, and
the context budget formula capped workspace content at 80 000 chars regardless of
how much context the model actually had. The cap dates to when all local models were
32 K — never revisited.

Two measurable consequences: context packing left 75–90% of available tokens unused
for workspace files, and session compaction triggered too early (same formula drives
the compaction threshold).

## Reading from the server

LM Studio exposes `/api/v0/models/{id}` — an extended endpoint beyond the standard
`/v1/models`. It returns the exact context length the model was loaded with:

```
loaded_context_length: 131072   // devstral, as configured by the user
loaded_context_length: 262144   // qwen/qwen3.6, same
```

Phase 146 adds `probeLMStudioContextWindow(baseUrl, model)`: a fast, silent probe
that fires at run start, before context packing. On any error (server unreachable,
non-LM Studio, 404) it returns null and the profile default wins. On success, the
discovered value overwrites the profile's `contextWindow` and cascades into both
the workspace-content budget and the session compaction threshold.

## Scaled budget formula

The old cap:
```
contextBudgetChars = min(raw, 80_000)   // always 80 000 for any context ≥ 32 K
```

The new formula:
```
scaledCap = min(320_000, max(80_000, contextWindow × 2))
contextBudgetChars = min(raw, scaledCap)
```

Results:
| Context window | Old budget | New budget | Change |
|---------------|-----------|-----------|--------|
| 32 768 | 80 000 chars | 80 000 chars | unchanged |
| 131 072 | 80 000 chars | 262 144 chars | 3.3× |
| 262 144 | 80 000 chars | 320 000 chars | 4× |

The 80 000 floor preserves behavior for small contexts. The 320 000 ceiling prevents
runaway context for very large models. Backward compatible: all existing tests pass
unchanged.

## Attribution

`contextWindowSource` in `summary.json` tells you where the value came from:
`'lmstudio-api'` when the probe succeeded, `'profile'` when it fell back. Useful
for `kodr forensics` and `kodr why` diagnostics.

## Interaction with explicit --context-window

The probe only fires when `--context-window` was not explicitly set. If you pass
`--context-window 65536`, that value wins and the probe is skipped.
