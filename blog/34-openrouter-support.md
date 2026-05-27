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

## First test run: gpt-5.4-nano generates todo-cli

With the flag working, the first real test was generating the standard todo-cli example using `openai/gpt-5.4-nano` via OpenRouter:

```
kodr run -p "..." --openrouter --model openai/gpt-5.4-nano --yes
```

The harness reported `Run ok`. Six files landed in `examples/gpt-5.4-nano/todo-cli/`: `src/cli.mjs`, `src/store.mjs`, two test files, `README.md`, and `package.json`. 4/5 tests passed immediately.

**Design differences from the reference todo-cli.** The model made two distinct choices compared to the hand-evolved original:

- **UUIDs instead of sequential integers.** `TodoStore.add` calls `randomUUID()` from `node:crypto` for each new item. The original uses `Math.max(0, ...ids) + 1`. UUID ids are collision-safe across concurrent writers; sequential ids are simpler to type in a CLI. Both are defensible.
- **Wrapped JSON envelope.** The store writes `{ "version": 1, "todos": [...] }` rather than a bare array. The original uses a bare array. The envelope makes forward migration easier; the bare array is simpler to inspect.

**One test bug.** The test "prints usage and exits non-zero when no command is provided" awaited `promisify(execFile)` without a `try/catch`. Since the CLI exits with code 1 in this case, `execFile` rejects and the test always throws. The model's own inline comment said "Actually execFile rejects" — it diagnosed the issue correctly but still wrote the broken code. The fix is a `try/catch` that captures `error.stdout` and `error.code` for assertions. This is a known failure pattern: models can state a constraint correctly in a comment while violating it in the code immediately below.

## Lessons

The pattern of applying provider defaults after argument parsing (rather than during) keeps `assignValue` clean and makes override precedence easy to reason about. The `_apiKeySet` tracking boolean on the options object is deleted before the options object is returned, so no internal state leaks to callers.

Keeping the whole change behind a single flag means local-first behaviour is unchanged. If `--openrouter` is absent, nothing in the code path runs differently.
