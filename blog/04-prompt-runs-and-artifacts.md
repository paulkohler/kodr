# Phase 04: Prompt Runs And Artifacts

Phase 04 adds the first repeatable prompt run.

## Decision

Keep `koder run` small, but extract shared OpenAI-compatible client and artifact helpers before adding it.

## Design

`koder run` accepts prompt text with `-p` or `--prompt`, or reads a file with `--prompt-file`. It writes artifacts to `.koder/runs/<timestamp>/` by default, or to `--out`.

Each run writes:

- `prompt.md`: exact prompt input
- `response.md`: stitched assistant response
- `summary.json`: stable metadata for comparison
- `raw-response.json`: raw chat completion response bodies

The summary avoids timestamps so two runs can be compared by model, prompt size, response size, finish reasons, and response count.

## Continuations

If a response has `finish_reason: "length"`, Kodr asks the model to continue and stitches the next assistant message directly onto the previous text. The raw response artifact preserves every response body so the stitching can be inspected later.

## Verification

```sh
npm run format
npm test
npm run check
```
