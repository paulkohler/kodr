# Phase 27: Patch-Oriented Repairs

The CSV regeneration attempt showed that full-file rewrites are too blunt for repair loops. The model could improve one area while accidentally changing unrelated behavior, and each retry made the file harder to reason about.

This phase adds a narrower proposal format:

```json
{
  "patches": [
    {
      "path": "src/file.mjs",
      "search": "exact current text",
      "replace": "replacement text"
    }
  ]
}
```

Patches use the same path jail as full-file writes. A patch applies only when its search text matches exactly once in the current file, so stale or ambiguous edits fail before touching the workspace. Failed patches now still write run artifacts, including summary, tasks, response, and write error details.

The first live patch repair also found a practical model-output issue: patch strings may arrive with double-escaped newlines. Kodr now has a conservative fallback that normalizes those escapes only when the original text matches zero times and the normalized text matches exactly once.

This does not replace memory or scratchpads. It gives the next CSV regeneration attempt a safer edit primitive, and the remaining failure mode points directly at the need for better task decomposition and scratchpad state.
