# Example: File Upload Server

An Express server that accepts file uploads via multipart form and serves them back.
Single session, in-memory store.

**Workspace:** `~/src/kodr-testing/phase-204/file-upload-3`  
**Model:** `qwen/qwen3.6-35b-a3b`

## Files

```
package.json          — {"type":"module","dependencies":{"express":"^4","busboy":"^1"}}
src/store.mjs         — createStore(), saveFile(store, name, buf), listFiles(store), getFile(store, name)
src/server.mjs        — createServer(store) → Express app
test/server.test.mjs  — node:test: 5 integration tests via raw node:http multipart
```

## Prompt (succeeded on 3rd attempt)

```
Build an Express file-upload server.

package.json — {"type":"module","dependencies":{"express":"^4","busboy":"^1"}}.

src/store.mjs — in-memory store (no disk I/O needed).
  export function createStore() { return { files: new Map() }; }
  export function saveFile(store, name, buffer) {
    store.files.set(name, buffer);
    return { name, size: buffer.length };
  }
  export function listFiles(store) { return [...store.files.keys()]; }
  export function getFile(store, name) { return store.files.get(name) ?? null; }

src/server.mjs — import express and Busboy.
  IMPORTANT: busboy v1 exports a factory function, NOT a constructor.
  Use: const busboy = Busboy({ headers: req.headers });
  NOT: new Busboy({ headers: req.headers });  // TypeError: Busboy is not a constructor

  export function createServer(store) {
    const app = express();

    app.post('/upload', (req, res) => {
      const busboy = Busboy({ headers: req.headers });
      const saves = [];
      busboy.on('file', (_field, stream, info) => {
        const chunks = [];
        stream.on('data', c => chunks.push(c));
        stream.on('end', () => {
          const buf = Buffer.concat(chunks);
          saves.push(saveFile(store, info.filename, buf));
        });
      });
      busboy.on('finish', () => res.json({ uploaded: saves }));
      req.pipe(busboy);
    });

    app.get('/files', (_req, res) => res.json({ files: listFiles(store) }));

    app.get('/files/:name', (req, res) => {
      const buf = getFile(store, req.params.name);
      if (!buf) return res.status(404).json({ error: 'File not found' });
      res.set('Content-Type', 'application/octet-stream');
      res.send(buf);
    });

    return app;
  }

test/server.test.mjs — node:test integration tests using node:http (not fetch — multipart needs raw HTTP).
  Use before/after hooks for a single shared server instance.
  after(): server.closeAllConnections?.(); await new Promise(r => server.close(r));
  Listen on port 0; capture actual port from server.address().port.

  Helper to build multipart body manually (include file content bytes):
    function buildMultipart(filename, content, boundary) {
      const buf = typeof content === 'string' ? Buffer.from(content) : content;
      const header = Buffer.from(
        '--' + boundary + '\r\n' +
        'Content-Disposition: form-data; name="file"; filename="' + filename + '"\r\n' +
        'Content-Type: application/octet-stream\r\n\r\n'
      );
      const footer = Buffer.from('\r\n--' + boundary + '--\r\n');
      return Buffer.concat([header, buf, footer]);
    }

  Tests:
    - GET /files returns 200 {files:[]}
    - POST /upload with a text file returns 200 {uploaded:[{name:'test.txt',size:11}]}
    - GET /files after upload returns {files:['test.txt']}
    - GET /files/test.txt returns the file bytes
    - GET /files/missing.txt returns 404

package.json — add 'scripts':{'test':'node --test'}
```

## Run

```sh
mkdir -p ~/src/kodr-testing/phase-204/file-upload-3
cd ~/src/kodr-testing/phase-204/file-upload-3
echo '{"type":"module","dependencies":{"express":"^4","busboy":"^1"}}' > package.json
npm install

kodr run --yes --no-heal --no-tools --no-inspect-context --no-protect-existing \
  --test "node --test" --max-turns 20 -p "<prompt>"
```

## Result

Run ok on first attempt with this prompt.  
Tokens: 3,556 (prompt 1,666 / completion 1,890). Tests: 5/5 passing.

## Failed attempts (see process/failures.jsonl)

| Attempt | Error |
|---------|-------|
| file-upload-1 | Test process hung 600s — no `server.closeAllConnections()`, multipart body was headers-only (no content bytes) |
| file-upload-2 | `new Busboy()` → TypeError: Busboy is not a constructor; heal loop context overflow |

## Notes

- busboy v1 changed from class to arrow function factory. The explicit warning in the prompt
  was essential — the model had learned the v0.x class-based API from training data.
- Multipart body helpers must include the actual file bytes between the MIME header and footer.
  The boundary lines need `\r\n` separators (CRLF), not just `\n`.
- Raw `node:http` is better than `globalThis.fetch` for multipart tests — easier to control
  exact Content-Type header with boundary parameter.
- `server.closeAllConnections?.()` is needed before `server.close()` to release keep-alive
  connections and let `node --test` exit.
- `--no-heal` with `--no-inspect-context` is the reliable pattern for qwen3.6: full context
  in, no repair loop that can overflow the 32K token window.
