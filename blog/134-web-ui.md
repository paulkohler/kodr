# Phase 134: The Window You Didn't Know Was Missing

`kodr serve` has had a complete JSON control plane since phase 85. Every run
submission, SSE event stream, artifact list, session continuation, and forensics
page was reachable via `curl`. Nobody reached for `curl`. The information was all
there; the friction of composing it by hand kept it academic.

Phase 134 adds a window.

## What it wasn't

The temptation with "add a web UI" is to reach for a framework, a bundler, a
CDN, a design system. The constitution forbids all of these: zero runtime
dependencies, pure Node.js built-ins. So the question was whether a genuinely
useful UI was achievable without any of that infrastructure. The answer turned
out to be: yes, with one small design insight.

## The asset-resolution trick

The thing that makes `kodr serve` unusual is that it's invoked from arbitrary
workspaces, not from the repo root. `kodr serve` in `~/projects/my-app` needs
to find `src/web/index.html` in the kodr install. Resolving relative to
`process.cwd()` breaks. Resolving relative to `import.meta.url` — the server
module's own URL — doesn't. The built shim from phase 15 keeps the source tree
in place, so `fileURLToPath(new URL('./web/', import.meta.url))` finds the
assets identically from any cwd.

A `--web-dir` flag overrides this for custom UIs. The traversal guard
(resolve + `startsWith(webDir + sep)`) and extension allowlist are the same
pattern as `serveRunArtifact`, which had already solved the identical problem
for run artifacts.

The first debugging session on this: `fileURLToPath` is from `node:url`, not
`node:path`. The import was wrong. Node threw an unhelpful "does not provide an
export named 'fileURLToPath'" error. Fixed in the same commit — no process entry
needed for a one-line mistake — but the correct module is worth remembering.

The second: the `fileURLToPath` for a directory URL returns a path with a
trailing slash. `webDir + sep` then becomes a double-slash, and nothing matches
the guard. The fix is to strip the trailing sep before storing `webDir`. Both
bugs appeared in the first test run and were gone within minutes.

## Tokens: live only

The SSE event stream today carries `agent_start`, `agent_finish`, `log`, and
`done` — enough to know that something is happening, not enough to read the
model's output as it arrives. Adding live tokens to the stream is a one-line
callback thread: `onToken` in `createChatCompletion` → `requestStreamJson` →
`readServerSentEvents` → `applyStreamEvent` fires it per content delta, wrapped
in a try/catch so a throwing consumer can't break the read loop.

The harder question was what to do with token events on the registry side. The
answer: nothing permanent. `broadcastToken` fans out to current SSE subscribers
without touching the persisted event log. A reconnecting client gets the
`done` event and can read `response.md` from the artifacts endpoint; it doesn't
get flooded with every token that fired during the run. This is the right
boundary: tokens are a live rendering aid, not a durable record, and keeping
them out of the replay buffer means memory stays bounded regardless of run
length.

The SSE `writeEvent` function needed a matching fix: token events have `id:
null` (not persisted, so they carry no sequence number). Emitting `id: null`
in the SSE wire would reset the client's `Last-Event-ID` to the string `"null"`,
corrupting replay position. The fix is to skip the `id:` line for events with
a null id.

## The UI itself

Three panels, one HTML file, one CSS file, one JS file — all vanilla, no
framework, no CDN. New-run form submits to `POST /runs` and opens an
`EventSource` on the returned `eventsUrl`. Token events append to a streaming
pre element; progress/log/done events render below with distinct styling. The
form re-enables on `done`. The runs list shows all runs with status badges and
click-through to detail and `/why`. Sessions list supports continuation via
`POST /sessions/:id/turns`. `localStorage` persists model, test command, and a
ten-entry prompt history.

The window test — "does a browser actually work here?" — is the live validation
step documented in the phase file, left to the operator. The unit tests cover
the traversal guard, the content-type mapping, the token live-only invariant,
and the API-precedence guarantee. That's the scope where unit tests add value;
a browser interaction test is the scope where they add noise.

## What it shows

The forensics arc that started at phase 127 was about making existing data
readable. This phase is the same move one level up: the entire control plane
was already there. The window just needed to exist.
