# IncomingMessage Has No .text() or .json()

Phase-252 dogfood. The model was asked to write an HTTP server with a JSON
request body. It produced:

```js
import http from 'node:http';

const server = http.createServer(async (req, res) => {
  const body = await req.text();
  const data = JSON.parse(body);
  // ...
});
```

The server started fine. The first POST request crashed it:

```
TypeError: req.text is not a function
```

## Why it happened

`req` inside an `http.createServer` handler is an
[`http.IncomingMessage`](https://nodejs.org/api/http.html#class-httpincomingmessage).
It is a Node.js `Readable` stream. It has no `.text()` or `.json()` method.

Those methods exist on the Web Fetch
[`Request`](https://developer.mozilla.org/en-US/docs/Web/API/Request) object —
the `req` you get from a `fetch()` handler in service workers, Deno, Bun, and
the Web Platform in general. They do not exist in Node's `http` module.

The model knows both APIs. When the context clues point toward "HTTP server" and
"request body", it reaches for the Web Fetch form because `.text()` and `.json()`
are shorter and more idiomatic in the modern fetch world. But `http.createServer`
is the classic Node.js API, and the `IncomingMessage` it hands you predates the
Fetch standard by a decade.

## The correct pattern

Reading a body from `IncomingMessage` requires listening to stream events:

```js
const body = await new Promise((resolve, reject) => {
  const chunks = [];
  req.on('data', chunk => chunks.push(chunk));
  req.on('end', () => resolve(Buffer.concat(chunks).toString()));
  req.on('error', reject);
});
const data = JSON.parse(body);
```

It is verbose compared to `await req.json()`, but it is the only way on the
built-in `http` module without a framework.

## What was added

A pitfall block placed at the end of the `## HTTP integration test patterns`
section of `src/builtin-skills/languages/node/SKILL.md`, immediately before the
`## Test isolation` section:

```
**IncomingMessage has no `.text()` or `.json()`** — those methods exist on the
Web Fetch `Request` API, not on Node's `http.IncomingMessage`. ...
```

The placement is deliberate. The HTTP section is gated — it only appears when
the task mentions a server keyword. That is exactly the right time to show this
pitfall: the model is already thinking about `http.createServer` handlers and is
about to decide how to read the request body.

## Size guards raised

The pitfall block adds ~500 chars to the HTTP section. Three size-guard ceilings
in `test/system-env.test.mjs` needed updating:

- Auto mode (Node/ESM greenfield): 13,700 → 14,200
- Native mode (Node/ESM): 12,500 → 13,200
- ESM block integration test: 13,700 → 14,200

The native mode guard had not been updated since Phase 257 extracted lang:sqlite,
so it had headroom. After Phase 263 it sits at ~13,085, still well under 13,200.
