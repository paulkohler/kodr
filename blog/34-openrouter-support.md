# Phase 34: OpenRouter Support

Phase 34 adds `--openrouter` as a first-class provider flag. The goal was to let a run target [OpenRouter](https://openrouter.ai) with a single flag and no boilerplate:

```
kodr run -p "just say hi" --openrouter
```

The core observation is that OpenRouter is fully OpenAI-compatible, so there is no new transport code. The entire change lives in option resolution and a small `extraHeaders` plumbing path in `model-client.mjs`.

## What the flag does

`--openrouter` sets a provider field in options and triggers a defaults pass after argument parsing:

- base URL → `https://openrouter.ai/api/v1`
- model → `openai/gpt-4o-mini` (cheap, reliable default)
- API key → `OPENROUTER_API_KEY` env var, falling back to `OPENAI_API_KEY`
- OpenRouter's recommended request headers (`HTTP-Referer`, `X-Title`) injected via a new `extraHeaders` option passed through the model-client call chain

Explicit `--base-url`, `--model`, and `--api-key` flags win over these defaults, so the flag stays composable.

## Early key validation

If `--openrouter` is set but neither `OPENROUTER_API_KEY` nor `OPENAI_API_KEY` is present, `parseArgs` throws a `CliError` before any network call happens. A clear message at parse time is far better than a cryptic 401 after the first model request is already in flight.

## Key resolution order

`OPENROUTER_API_KEY` takes precedence over `OPENAI_API_KEY` intentionally. A user may have `OPENAI_API_KEY` set for a different tool and want an independent OpenRouter key. The fallback exists so that users who only have the generic OpenAI key do not need to duplicate it.

## extraHeaders

The model client gained an `extraHeaders` field that gets spread into the `fetch` headers before `content-type` and `authorization` are applied. This is the minimal change needed to carry OpenRouter's headers without coupling the transport layer to any specific provider. It is also useful for future providers that need custom headers.

## Lessons

The pattern of applying provider defaults after argument parsing (rather than during) keeps `assignValue` clean and makes override precedence easy to reason about. The `_apiKeySet` tracking boolean on the options object is deleted before the options object is returned, so no internal state leaks to callers.

Keeping the whole change behind a single flag means local-first behaviour is unchanged. If `--openrouter` is absent, nothing in the code path runs differently.
