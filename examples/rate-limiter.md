# Example: Rate Limiter with Express

A sliding-window in-process rate limiter, with Express middleware and integration
tests. Single session.

**Workspace:** `~/src/kodr-testing/phase-204/rate-limiter-1`  
**Model:** `qwen/qwen3.6-35b-a3b`

## Files

```
package.json              — {"type":"module","dependencies":{"express":"^4"}}
src/limiter.mjs           — createLimiter(maxRequests, windowMs) → limit(key) fn
src/server.mjs            — createServer(limiter) → Express app
test/limiter.test.mjs     — unit tests: allow/block/expiry
test/server.test.mjs      — integration tests: 200/429 via node:http
```

## Prompt

```
Build a simple in-process rate limiter with Express (in node_modules already).

src/limiter.mjs — sliding window rate limiter:
  export function createLimiter(maxRequests, windowMs) {
    const counts = new Map(); // key => [timestamps]
    return function limit(key) {
      const now = Date.now();
      const timestamps = (counts.get(key) || []).filter(t => now - t < windowMs);
      if (timestamps.length >= maxRequests) return false;
      timestamps.push(now);
      counts.set(key, timestamps);
      return true;
    };
  }

src/server.mjs:
  export function createServer(limiter) {
    Creates an Express app. Single route: GET /api/data.
    The limiter is called with req.ip. If it returns false, respond 429 JSON
    { error: 'Rate limit exceeded' }. Otherwise respond 200 JSON { data: 'ok' }.
    Returns the app (not a listening server).
  }

test/limiter.test.mjs — node:test unit tests (no server):
  Test: createLimiter(3, 1000) allows first 3 calls and blocks 4th for same key.
  Test: createLimiter(3, 1000) allows calls from different keys independently.
  Test: createLimiter(3, 100) allows again after window expires (wait 110ms).

test/server.test.mjs — node:test integration test with node:http:
  Single server instance: use before/after hooks to start/stop cleanly.
  after: server.closeAllConnections?.(); await new Promise(r => server.close(r));
  Test: GET /api/data within limit returns 200.
  Test: GET /api/data over limit returns 429.

package.json — patch to add: 'scripts': { 'test': 'node --test test/*.test.mjs' }
```

## Run

```sh
mkdir -p ~/src/kodr-testing/phase-204/rate-limiter-1
cd ~/src/kodr-testing/phase-204/rate-limiter-1
echo '{"type":"module","dependencies":{"express":"^4"}}' > package.json
npm install

kodr run --yes --heal --no-tools --test "node --test" --max-turns 20 \
  --no-inspect-context --no-protect-existing -p "<prompt>"
```

## Result

Run ok on first attempt.  
Tokens: 1,365 prompt / 1,352 completion. Tests: 5/5 passing.

## Notes

- Model correctly used `server.closeAllConnections?.()` in the `after` hook — the
  explicit instruction in the prompt was needed (without it the server hangs, see
  the file-upload failure entries in `process/failures.jsonl`).
- The integration test uses a 5-second window (`createLimiter(3, 5000)`) to avoid
  the window expiring mid-test.
- `--no-protect-existing` needed because `package.json` existed before the run.

## Original planned prompt (for future comparison runs)

```
Create a sliding-window rate limiter in Node.js using only built-in modules.

src/window.mjs — export class SlidingWindow(limit, windowMs). It stores request
timestamps for a single key and exposes: record() to register a request, check()
to return { allowed: boolean, remaining: number, resetAt: number (ms epoch) }.
Remove timestamps older than windowMs on each call.

src/limiter.mjs — export class RateLimiter(store, options) where options = {
limit, windowMs }. Expose check(key) that delegates to the store's SlidingWindow.

test/window.test.mjs — node:test tests: initial state allows, fills up to limit,
rejects when full, allows again after window expires.
```
