# Phase 146 — LM Studio Context Window Auto-Discovery

## Motivation

Static model profiles hardcode context windows at conservative values (32 768 for
qwen/qwen3.6 and the devstral fallback). Users who run models at larger loaded
contexts — devstral at 131 072, qwen at 262 144 — were silently capped. All three
values that depend on the context window (contextWindow, contextBudgetChars, and
sessionContextChars) under-reported actual capacity, leaving 75–90% of available
context unused.

The LM Studio `/api/v0/models/{id}` endpoint already exposes `loaded_context_length`
— the exact value the model was loaded with. Phase 146 probes that endpoint at
run start and updates options before context packing.

## Design

### Probe

`probeLMStudioContextWindow(baseUrl, model)` (exported from `model-profiles.mjs`):
- Constructs `${origin}/api/v0/models/${encodedModel}` from the active base URL.
- Issues a `fetch` with a 3-second timeout.
- Returns `loaded_context_length` if present and positive, null otherwise.
- Silent on any error — probe failure falls back to the profile value.

Called in `runPrompt` (before `resolveParentSession` / context packing) when
`options._contextWindowSet` is false.

### Scaled budget formula

`contextBudgetCharsForWindow(contextWindow, completionReserve)`:
```
raw = (contextWindow - completionReserve) * 4
scaledCap = min(320_000, max(80_000, contextWindow * 2))
result = min(raw, scaledCap)
```

- 32 768 → 80 000 chars (unchanged — backward compatible)
- 131 072 → 262 144 chars (≈ 65 K tokens)
- 262 144 → 320 000 chars (≈ 80 K tokens, ceiling)

Replaces the hardcoded `Math.min(raw, 80000)` in `applyModelProfileDefaults`.
Also recomputes `sessionContextChars` proportionally when the probe overrides
the context window.

### Attribution

`contextWindowSource` added to all three `summary.json` write sites:
- `'lmstudio-api'` when the probe overrode the profile
- `'profile'` when the probe returned null or was skipped

### Fake server compatibility

The fake model server used in tests now absorbs GET `/api/v0/models/…` silently
(404 without recording) so test assertions on `server.recordings` remain stable.

## Files changed

- `src/model-profiles.mjs`: `contextBudgetCharsForWindow` export, `probeLMStudioContextWindow` export, replaced 80 000 cap.
- `src/app.mjs`: import additions, probe call in `runPrompt`, `contextWindowSource` in all three summary sites.
- `test-support/fake-model-server.mjs`: absorb `/api/v0/models/` without recording.
- `test/model-profiles.test.mjs`: 6 new tests for `contextBudgetCharsForWindow` and `probeLMStudioContextWindow`.

## Done criteria

- [x] `probeLMStudioContextWindow` returns 131 072 for devstral and 262 144 for qwen against live LM Studio.
- [x] `contextBudgetCharsForWindow(32768, 4096)` = 80 000 (unchanged); 131 072 → 262 144; 262 144 → 320 000.
- [x] Probe overrides `contextWindow`, `contextBudgetChars`, `sessionContextChars` in `runPrompt`.
- [x] `contextWindowSource: 'lmstudio-api'` recorded in summary when probe fires.
- [x] `--context-window` explicit flag still wins (probe skipped when `_contextWindowSet`).
- [x] Fake server absorbs probe requests without affecting test recordings.
- [x] Tests: 1402/1402 (6 new tests added).
- [x] Version 0.0.146; committed.
