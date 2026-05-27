# Phase 34: OpenRouter Support

## Goal

Let a run target [OpenRouter](https://openrouter.ai) as the model provider instead of
the default local LM Studio endpoint, keeping the local-first defaults intact. A
single `--openrouter` flag should be enough to switch providers using sensible
defaults, with the API key sourced from the environment so secrets stay off the
command line.

Target usage:

```
kodr run -p "just say hi" --openrouter
```

## Design

OpenRouter is OpenAI-compatible, so it slots into the existing `model-client.mjs`
request path. The work is mostly about provider selection and defaults in
`parseArgs` / option resolution, not new transport code.

- Introduce a `provider` concept (`local` default, `openrouter`).
- `--openrouter` is shorthand that selects the provider and applies its defaults
  unless the user overrides them:
  - base URL: `https://openrouter.ai/api/v1`
  - API key: `OPENROUTER_API_KEY` from env (fall back to `OPENAI_API_KEY`)
  - model: an OpenRouter-style default (e.g. a free/cheap chat model), still
    overridable with `--model`.
- Explicit `--base-url`, `--model`, and `--api-key` always win over provider
  defaults so the flag stays composable.
- Send OpenRouter's recommended optional headers (`HTTP-Referer`, `X-Title`)
  when the provider is OpenRouter; keep them absent for local runs.
- Fail clearly if `--openrouter` is set but no API key can be resolved, before
  any network call.
- Continue treating model output as untrusted and keep dry-run defaults.

## Done Criteria

- [x] Add a `--openrouter` flag plus provider resolution to `parseArgs`, with the
      precedence rules above.
- [x] Resolve OpenRouter API key from `OPENROUTER_API_KEY` (then `OPENAI_API_KEY`)
      and error early when missing.
- [x] Apply OpenRouter base URL / default model / optional headers in the model
      client request path.
- [x] Update help text and README to document `--openrouter` and the env vars.
- [x] Add `node:test` coverage for provider resolution, defaulting, override
      precedence, and the missing-key error.
- [x] Record a decision in `process/decisions.jsonl` and any harness/app failures
      in `process/failures.jsonl`.
- [x] Add or update the matching blog post.
