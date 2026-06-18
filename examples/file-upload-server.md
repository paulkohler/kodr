# Example: File Upload Server

A two-session Express server that accepts file uploads via multipart form,
stores them on disk, and serves a simple HTML UI. Session 1 builds the API.
Session 2 adds a static frontend and a download endpoint. Designed to exercise:

- Express + multipart upload (using `node:stream` + manual boundary parsing, OR
  a clean approach via `busboy` if the model chooses — we note both and see what happens)
- `express-async-route` sensor: route handlers must be arrow functions
- `protectExisting`: Session 2 patches server.mjs, does not rewrite it
- `--test-timeout`: upload tests complete in bounded time

## File structure after Session 1

```
package.json          — {"type":"module","dependencies":{"express":"^4","busboy":"^1"}}
src/store.mjs         — saveFile(name, stream), listFiles(), getFilePath(name)
src/server.mjs        — createApp(storeDir), startServer(port)
test/server.test.mjs  — node:test: POST /upload → 201, GET /files → JSON list
```

## File structure after Session 2

```
(Session 1 files patched, not rewritten)
public/index.html     — HTML form: file input + submit → POST /upload; lists files
src/static.mjs        — serveStatic(app): serves public/ dir
src/server.mjs        — patched: import serveStatic, call after API routes
test/static.test.mjs  — GET / returns 200 with HTML
```

## Session 1 prompt

```
Build an Express file-upload server.

package.json — {"type":"module","dependencies":{"express":"^4","busboy":"^1"}}.

src/store.mjs — Manages uploaded files in a directory.
  Export async function saveFile(storeDir, name, stream): mkdir storeDir, pipe
    stream to fs.createWriteStream(join(storeDir, name)), return path.
  Export function listFiles(storeDir): readdirSync(storeDir) filtered to files,
    return array of names. Return [] if dir doesn't exist.
  Export function getFilePath(storeDir, name): join(storeDir, name).

src/server.mjs — import express; import Busboy from 'busboy'; import store.
  Export function createApp(storeDir):
    const app = express(); app.use(express.json()).
    POST /upload: parse multipart with Busboy. For each file field, call
      saveFile(storeDir, filename, fileStream). Respond 201 {saved: filename}.
      Route handler must be: app.post('/upload', async (req, res) => { ... })
    GET /files: respond 200 {files: listFiles(storeDir)}.
    Return app.
  Export async function startServer(port=3000, storeDir='./uploads'):
    const app = createApp(storeDir). app.listen(port).
    Return {app, server, close: () => new Promise(r => server.close(r))}.

test/server.test.mjs — node:test integration tests.
  In before(): startServer(3001, tmpStoreDir). In after(): close().
  Use globalThis.fetch.
  Tests:
    - GET /files returns 200 with {files: []} initially
    - POST /upload with a text file returns 201 {saved: 'test.txt'}
    - GET /files after upload returns {files: ['test.txt']}
```

## Session 2 prompt

```
The upload API is done and tests pass. Add a browser frontend.

public/index.html — Simple HTML page:
  Title: "File Uploader". A <form> with enctype="multipart/form-data" and
  method="post" action="/upload". A file input named "file". A submit button.
  Below the form, a <div id="files"> that on page load fetches GET /files and
  renders the filenames as a <ul>.

src/static.mjs — import express; import { fileURLToPath } from 'node:url';
  import { dirname, join } from 'node:path'.
  const __dirname = dirname(fileURLToPath(import.meta.url)).
  Export function serveStatic(app):
    app.use(express.static(join(__dirname, '..', 'public'))).
    app.get('*', (req, res) => res.sendFile('index.html', {root: join(__dirname,'..','public')})).

Patch src/server.mjs: import { serveStatic } from './static.mjs'.
  In createApp(storeDir), call serveStatic(app) after API routes.

test/static.test.mjs — node:test: startServer(3002, tmpDir).
  Test: GET / returns 200 and body contains 'File Uploader'.
  Teardown: close().
```

## What to watch for

- Does the model use `async (req, res) => { ... }` for route handlers (not call expressions)?
- Does the `express-async-route` sensor fire if the model makes the mistake?
- Does `protectExisting` force Session 2 to patch `src/server.mjs`?
- Does `busboy` work correctly in an ESM context?

## Run commands

```sh
mkdir -p ~/src/kodr-testing/phase-204/file-upload-1
cd ~/src/kodr-testing/phase-204/file-upload-1
npm install  # after Session 1 creates package.json
kodr run --yes --heal --test "node --test" --max-turns 20 -p "<session 1 prompt>"

# Session 2
kodr run --yes --heal --test "node --test" --max-turns 20 -p "<session 2 prompt>"
```
