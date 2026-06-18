# Example Idea: Real-Time Collaborative Notes

A live note-editing server using `node:sqlite` for persistence and the `ws` npm
package for WebSocket broadcasting. Multiple clients connect, edits are broadcast
to all others and persisted immediately. Two kodr sessions: Session 1 builds the
server; Session 2 adds the browser client and a multi-connection integration test.

## Areas exercised

- `node:sqlite` persistence with Node 24 native API
- `ws` WebSocket server on top of an existing `node:http` server
- Protocol design: typed message objects (`{ type, payload }`)
- Session 2 extends live server with a vanilla HTML/JS client (no build tools)
- Multi-connection test: two simultaneous WebSocket clients, assert broadcast delivery
- Heal loop pressure: `ws` API differences, JSON parse errors, async close teardown

## File structure after Session 1

```
package.json       — ESM, dependencies: ws
src/db.mjs         — openDb(path), runMigrations(db), saveNote(db, content), loadNote(db)
src/server.mjs     — createServer(db, opts): http.createServer + WebSocket.Server upgrade;
                     broadcast({ type:'note', content }) on each edit
src/protocol.mjs   — MSG_TYPES = { NOTE_UPDATE, NOTE_INIT, ERROR }; parse(raw); encode(msg)
test/server.test.mjs — node:test: server starts, single client receives NOTE_INIT on connect
```

## File structure after Session 2

```
(all Session 1 files unchanged)
public/index.html  — vanilla HTML + JS; connects WebSocket to same origin;
                     textarea whose 'input' event sends NOTE_UPDATE; renders
                     inbound NOTE_UPDATE from other clients into a read-only div
src/static.mjs     — serveStatic(app): serves public/index.html on GET /
test/server.test.mjs  — + multi-client broadcast test: client A sends edit,
                          assert client B receives it; assert persistence via loadNote
test/protocol.test.mjs — parse/encode round-trip tests
```

## Session 1 prompt

```
Build a real-time collaborative note server in Node.js.

package.json — {"type":"module","dependencies":{"ws":"^8"}}, no other runtime deps.

src/db.mjs — import DatabaseSync from 'node:sqlite'. Export:
  openDb(path): returns new DatabaseSync(path)
  runMigrations(db): creates table notes(id integer primary key, content text not null,
    updated_at integer not null) if not exists
  saveNote(db, content): upserts id=1 row with content and Date.now(), returns the row
  loadNote(db): returns the id=1 row or null

src/protocol.mjs — export const MSG_TYPES = { NOTE_UPDATE:'note_update', NOTE_INIT:'note_init',
  ERROR:'error' }.
  export function encode(type, payload): returns JSON.stringify({type, payload})
  export function parse(raw): returns parsed {type, payload} or throws Error

src/server.mjs — import {WebSocketServer} from 'ws'; import http from 'node:http'.
  Export function createServer(db, opts={port:8080}):
    - creates an http.createServer that handles GET /healthz → 200 "ok"
    - upgrades to WebSocket via new WebSocketServer({server})
    - on ws 'connection': send NOTE_INIT with the current note content (loadNote)
    - on ws 'message': parse the message; if NOTE_UPDATE, call saveNote, broadcast
        encode(NOTE_UPDATE, {content}) to all other connected clients
    - on ws 'close': remove from client set
    Returns {server, wss, close(): closes server and wss}.

test/server.test.mjs — node:test tests using ':memory:' database. Import WebSocket
  from 'ws'. In beforeEach: open fresh db, runMigrations, startServer on a free port
  (port:0 → server.address().port). In afterEach: close the server. Tests:
  - GET /healthz returns 200
  - client receives NOTE_INIT on connect (content is null or empty)
  - client sends NOTE_UPDATE, server saves it; loadNote returns new content
```

## Session 2 prompt (fresh run in same workspace)

```
The WebSocket server is done. Add a browser client and extend tests.

public/index.html — standalone HTML file (no build step, no framework). Contains:
  - A <textarea id="editor"> for writing notes
  - A <div id="remote"> labelled "Remote edits:" showing content from other clients
  - Inline <script type="module">: open WebSocket to ws://${location.host};
      on open: send NOTE_INIT request (type:'note_update_request' with empty payload)
      on message: parse JSON; if type is 'note_init' or 'note_update', populate the
        textarea and remote div; on textarea 'input': debounce 300ms, send
        encode('note_update', {content: textarea.value})
  - Minimal inline CSS: textarea and remote div side by side, full height

src/static.mjs — export function serveStatic(httpServer): registers a listener for
  the http server's 'request' event. If req.url is '/' or '/index.html', read
  public/index.html with node:fs/promises and respond with it as text/html.
  Calls httpServer.on('request', handler) — does NOT replace the existing handler.

Update src/server.mjs: import serveStatic from './static.mjs'; call
  serveStatic(server) after creating the http server but before ws upgrade.

test/server.test.mjs — add to existing test file:
  - two-client broadcast: clientA connects, clientB connects, clientA sends
    NOTE_UPDATE, assert clientB receives the broadcast within 1 second (use a
    Promise + setTimeout race). Assert loadNote matches sent content.

test/protocol.test.mjs — node:test:
  - encode + parse round-trip for NOTE_UPDATE
  - parse throws on invalid JSON
  - parse throws on missing type field
```

## Lessons from the 2026-06-18 trial run (qwen3.6, 32K context)

### Session 1 — tool-call write deferral

First run (with tools): model called `write_file` for all 4 files in turn 10.
Tool result: "recorded write_file: ... — applies when the task completes".
Model then called `run_command("node --test")` repeatedly (turns 15–21).
Tests failed because writes were staged (not yet on disk). Model looped.
`writes.json: applied: false, writes: []`.

**Root cause**: the tool-call write path defers writes until the conversation
ends cleanly. Calling `run_command` before that point sees an empty workspace.

Fix: `--no-tools` forces the JSON-envelope path where writes are applied immediately.

### Session 1 — WebSocket NOTE_INIT race condition

Second run (--no-tools): 4 files written in one pass. 3/4 tests passed.
Failing: `two clients: clientA sends NOTE_UPDATE, clientB receives it` — `nextMsg(clientB)`
resolved with NOTE_INIT instead of NOTE_UPDATE, causing assertion failure.

Took 3 targeted fix passes to resolve:

**Pass 1** (drain approach): `await nextMsg(clientA); await nextMsg(clientB)` before
listening for NOTE_UPDATE. Broke test 2 (`NOTE_INIT` test now hung), because NOTE_INIT
for clientA arrived during clientB's `await connect()` before the drain listener was
registered.

**Pass 2** (waitForType): replaced nextMsg with `waitForType(ws, type)` — a persistent
`ws.on('message', handler)` that ignores non-matching messages. Fixed the broadcast
test (test 4), but test 2 (NOTE_INIT) started hanging when run in isolation.

**Pass 3** (pre-connection handler): the root cause is that NOTE_INIT arrives in the
same I/O batch as the WebSocket 'open' event. Registering a handler AFTER `await
connect()` always misses it. Fix: create the WebSocket and register the 'message'
listener INSIDE the Promise constructor, BEFORE the connection opens.

Final test result: 4/4 green.

### Key learnings

| Observation | Detail |
|-------------|--------|
| Tool-call write deferral | write_file tool calls stage writes; run_command in the same session sees empty workspace |
| --no-tools workaround | Forces JSON-envelope path; writes applied before heal loop runs tests |
| NOTE_INIT I/O timing | Server sends NOTE_INIT synchronously on 'connection'; it arrives in the same I/O batch as 'open' |
| nextMsg / waitForType still races | Any handler registered AFTER await connect() can miss the first message |
| Pre-connection handler is the fix | Register ws.on('message') inside the connect Promise, before the socket opens |
| Runs with test 1 first | When test 1 (healthz, 8ms) ran before NOTE_INIT test, the timing gap allowed waitForType to work — masked the bug |
| 3 fix passes needed | Each pass got one layer closer; model needed explicit root cause (I/O batch) to produce the right fix |

### Session 2

First pass applied `public/index.html`, `src/static.mjs`, updated `src/server.mjs`, and
created `test/static.test.mjs`. Two regressions introduced:

**Regression 1 — `db.mjs` switched to `better-sqlite3`**: Model reverted to the npm
package it knows well, ignoring the existing `node:sqlite` implementation. Required a
targeted restore pass.

**Regression 2 — wrong `encode` signature in server.mjs**: Server calls were written
as `encode({ type: MSG_TYPES.NOTE_INIT, payload: ... })` (object) instead of
`encode(MSG_TYPES.NOTE_INIT, { content: ... })` (two args). The protocol's `encode(type, payload)`
expected two arguments. This made `msg.type` an object on the client side —
`waitForType` never matched → tests hung.

**Leftover drain from earlier fix pass**: test 4 still had the `await nextMsg(clientA/B)`
drain lines that raced against NOTE_INIT. Needed one more pass to remove them, since
`waitForType` correctly ignores non-matching messages.

Final: 8/8 tests green (4 server + 3 static + 1 suite).

### Key learnings (all sessions combined)

| Observation | Detail |
|-------------|--------|
| Tool-call writes defer | `write_file` stages writes; `run_command` in same session sees empty workspace. `--no-tools` forces immediate JSON-envelope apply |
| NOTE_INIT I/O race | Server sends NOTE_INIT in same I/O batch as 'open'. Handler must be registered BEFORE connecting, not after awaiting 'open' |
| waitForType vs drain | Drain (`await nextMsg` to skip) races on loopback. `waitForType` (persistent type-filter) is safe but still needs to be registered before connect fires for NOTE_INIT-type tests |
| Session 2 regressions | Model reverted db.mjs to better-sqlite3 and used wrong `encode` signature — common pattern: model imports from what it knows rather than what's already there |
| 5 targeted fix passes total | 3 for WebSocket test design, 1 for db.mjs restore, 1 for encode signature fix |
| `wss.clients` fine | ws@8 exposes `clients` Set directly; model used it correctly in server.mjs |

## What to watch for

- Does the model understand that `WebSocketServer` attaches to the existing `http.Server`
  (not a standalone server)? A common mistake is creating a second port.
- Does `serveStatic` correctly coexist with the existing request handler without
  replacing it?
- Does the broadcast test correctly handle async WebSocket message delivery?
- Does Session 2 read the Session 1 protocol constants correctly?
- How many heal cycles does each session need?

## Suggested models

qwen3.6 for both sessions. Note: `ws` version 8 uses named exports; check whether
the model writes `import WebSocket from 'ws'` or `import {WebSocket, WebSocketServer} from 'ws'`.

## Run commands

```sh
# Session 1
mkdir -p ~/src/kodr-testing/phase-201/collab-notes-1
cd ~/src/kodr-testing/phase-201/collab-notes-1
npm install
kodr run --yes --heal --test "node --test" --max-turns 20 -p "<session 1 prompt>"

# Session 2 (fresh run in same workspace)
kodr run --yes --heal --test "node --test" --max-turns 20 -p "<session 2 prompt>"

# Manual smoke: open two browser tabs at http://localhost:8080 and type in each
node -e "import('./src/server.mjs').then(m => m.createServer(...))"
```
