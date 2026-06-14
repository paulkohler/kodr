# Example Idea: Rate Limiter

A sliding-window HTTP rate limiter built in Node.js with no external dependencies.
Five to six interdependent source files where each module imports from the previous
one — designed to stress multi-file coordination and the heal loop.

## Areas exercised

- Multi-file coordinated generation (store → limiter → http; imports must align)
- Private class fields and Map internals (a devstral trap)
- Node.js built-in `node:http` server without a framework
- Test isolation (each test creates its own store/limiter instance)
- Heal loop pressure: cross-file import errors, wrong method signatures, off-by-one in window arithmetic

## File structure

```
src/window.mjs     — SlidingWindow(limit, windowMs): tracks request timestamps per key
src/store.mjs      — LRUStore(maxKeys): evicts oldest key when full, wraps SlidingWindow instances
src/limiter.mjs    — RateLimiter(store, config): check(key) → { allowed, remaining, resetAt }
src/http.mjs       — createLimitedServer(limiter, handler): Node http.createServer with rate header injection
test/window.test.mjs
test/limiter.test.mjs
```

## Suggested prompt (single shot)

```
Create a sliding-window rate limiter in Node.js using only built-in modules.

src/window.mjs — export class SlidingWindow(limit, windowMs). It stores request
timestamps for a single key and exposes: record() to register a request, check()
to return { allowed: boolean, remaining: number, resetAt: number (ms epoch) }.
Remove timestamps older than windowMs on each call.

src/store.mjs — export class LRUStore(maxKeys). Holds one SlidingWindow per key,
evicts the least-recently-used key when maxKeys is exceeded. Expose get(key) and
evict statistics via size getter.

src/limiter.mjs — export class RateLimiter(store, options) where options = {
limit, windowMs }. Expose check(key) that delegates to the store's SlidingWindow
and returns { allowed, remaining, resetAt }.

src/http.mjs — export function createLimitedServer(limiter, handler). Returns a
node:http server. Before calling handler, run limiter.check(remoteAddress); if not
allowed return 429 with X-RateLimit-Remaining and Retry-After headers. On allowed
requests, inject X-RateLimit-Remaining into the response before calling handler.

test/window.test.mjs — node:test tests for SlidingWindow: initial state allows,
fills up to limit, rejects when full, allows again after window expires (use
fake timestamps via Date.now override or just set windowMs very small and sleep).

test/limiter.test.mjs — node:test tests for RateLimiter: allow then reject, correct
remaining count, check that eviction doesn't break a concurrent key.

Use ES modules throughout. No npm dependencies.
```

## What to watch for

- Does the model declare `#timestamps` at the top of the class body? (devstral trap)
- Do the test files import from the correct relative paths?
- Does the http module use `node:http` or try to require express?
- How many heal cycles does it take to get `node --test` passing?

## Suggested models

- devstral: expect 1–2 heal cycles; model:devstral guidance should prevent the
  private-field declaration error
- qwen3.6: usually clean ESM; interesting to compare total cycle count

## Run command

```sh
mkdir -p ~/src/kodr-testing/rate-limiter-qwen
cd ~/src/kodr-testing/rate-limiter-qwen
kodr run -p "..." --model qwen/qwen3.6-35b-a3b

mkdir -p ~/src/kodr-testing/rate-limiter-devstral
cd ~/src/kodr-testing/rate-limiter-devstral
kodr run -p "..." --model mistralai/devstral-small-2-2512
```
