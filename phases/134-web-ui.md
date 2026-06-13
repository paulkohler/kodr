# Phase 134 — Web UI (`kodr serve`)

## Motivation

`kodr serve` (phases 50/85/106) already exposes a complete local-only JSON HTTP
control plane: `POST /runs` (202 + `eventsUrl`/`statusUrl`), `GET
/runs/:id/events` (SSE), `GET /runs`, `GET /runs/:id` + `/artifacts` + `/why`,
`GET /sessions`, `POST /sessions/:id/turns`, `POST /turn`, `POST
/runs/:id/cancel`. What is missing is (a) a human surface — a static, zero-build
single-page UI served by the same process — and (b) genuine **token** streaming:
the SSE event stream today carries only coarse `agent_start`/`agent_finish`,
`log`, and `done` events, never the model's tokens as they arrive.

This phase adds the static UI, serves it from a directory resolved relative to
the kodr install (so it works from any cwd), and threads a minimal `onToken`
callback so live tokens ride the existing SSE channel.

## The bundling question (design answer, no new machinery)

There is **no bundler and no build step**. `bin/install-local.mjs` writes a shim
(`exec node "<repo>/bin/kodr.mjs" "$@"`) — the source tree stays in place and the
package *is* the install. So the web assets live in `src/web/` next to the
source and are resolved with `new URL('./web/', import.meta.url)` →
`fileURLToPath`, i.e. relative to the **server module**, never to the run cwd.
That makes `kodr serve` work identically from `~/anywhere`. A `--web-dir <path>`
flag overrides the served directory for a custom UI; default empty → the
built-in `src/web/`. This keeps the zero-runtime-dependency constitution intact:
plain HTML/CSS/JS, served by `node:http`.

## Design principles

1. **API unchanged, additive only.** The existing routes keep precedence; a new
   static fall-through handles only otherwise-unmatched `GET`s. No API route
   shape changes.
2. **Resolve assets by `import.meta.url`, not cwd.** The serve dir travels with
   the package.
3. **Path-traversal safe.** Same guard as `serveRunArtifact` (resolve +
   `startsWith(webDir + sep)`), plus an extension allowlist.
4. **Tokens are live-only.** Token events broadcast to current SSE subscribers
   but are **not** persisted into the registry replay buffer (which `GET
   /events` replays from `eventsSince`) — otherwise a reconnecting client gets a
   flood and memory grows unbounded on long runs. Reconnecting clients rely on
   the accumulated `response.md` artifact, not token replay.
5. **Vanilla, zero deps.** No framework, no CDN, no inline `eval`. One HTML, one
   CSS, one JS file.

## Work items

### A — Static serving in `src/server.mjs`

- Resolve `webDir = options.webDir?.trim() ? resolve(options.webDir) :
  fileURLToPath(new URL('./web/', import.meta.url))`. Store on `state`.
- After all API route matches, before the final 404: a `serveStaticAsset`
  fall-through for `GET` only.
  - Map `/` and `''` → `index.html`.
  - Allowlist extensions: `.html`, `.js`, `.css`, `.svg`, `.ico`, `.map`, `.json`
    (json only for assets actually under webDir, not run artifacts).
  - Resolve against `webDir`, reject if the resolved path escapes `webDir`
    (`!resolved.startsWith(webDir + sep)` → 403).
  - `readFile`; 404 if missing. Set content-type by extension; `cache-control:
    no-cache` (dev-friendly; the UI is local).
- Do **not** let static serving shadow any API path: it runs only after every
  existing route check falls through.

### B — `--web-dir` flag (app.mjs)

- Default `webDir: ''` in options; parse `--web-dir <path>`; thread into the
  `startKodrServer({ options })` call (already passes `options`).
- Validate: when set, it is a non-empty string (existence is checked lazily at
  serve time so a typo surfaces as a 404, not a startup crash — but a clear
  `serve` help line documents it).
- Update `serve` usage/help to mention the web UI and `--web-dir`.

### C — Live token SSE (`onToken` thread-through)

- `src/model-client.mjs`: in the SSE content-delta parse path
  (`readServerSentEvents` / the content accumulation in `createChatCompletion`),
  call `options.onToken?.(deltaText)` for each non-empty content delta. Must not
  fire for reasoning-only or tool-call fragment deltas (content channel only).
  Guard with try/catch so a throwing callback never breaks the read loop.
- `completeWithContinuations` (and the tool-call path if trivially threadable):
  pass `onToken` from `runOptions` through to each `createChatCompletion`. Token
  numbering across continuations just continues — the UI concatenates.
- `src/app.mjs` run pipeline: set `onToken: (text) => emitProgress(runOptions, {
  event: 'token', text })` alongside the existing `onProgress` wiring (only when
  a consumer is present — i.e. always safe since `emitProgress` no-ops without
  `onProgress`).
- `src/run-registry.mjs`: add a **live-only** broadcast path. `recordEvent` (or a
  new `broadcastEvent`) forwards `event === 'token'` progress events to
  subscribers **without** appending to the persisted event log. Everything else
  is unchanged. `phaseForProgressEvent` ignores token events (returns null).
- `src/server.mjs` `executeRun.onProgress`: route token progress events through
  the live-only path; keep recording all other progress events as today.

### D — Web assets (`src/web/`)

`index.html` + `styles.css` + `app.js`, vanilla. Same-origin (`fetch('/...')`,
`new EventSource('/runs/:id/events')`). Features:

- **New run**: prompt textarea, model input, test command input, `apply`(=`yes`)
  toggle, `tools` toggle → `POST /runs` → on 202 open `EventSource(eventsUrl)`.
- **Live panel**: render `token` events appended into a streaming transcript;
  render `progress` (agent_start/finish), `log` lines, and the terminal `done`
  status distinctly. Re-enable the form on `done`.
- **Runs list**: `GET /runs`, status badges, click → detail (`GET /runs/:id`,
  `/artifacts`, link out to `/runs/:id/why`). A `cancel` button → `POST
  /runs/:id/cancel`.
- **Sessions**: `GET /sessions`; pick one to continue → `POST
  /sessions/:id/turns` (same live panel).
- **localStorage**: persist model, test command, toggles, and a short prompt
  history; restore on load. No secrets are involved (local-only server, no
  auth).

## Testing (`node:test`, no live model)

- `test/server.test.mjs`:
  - `GET /` serves `index.html` (200, `text/html`); `GET /app.js` →
    `application/javascript`; `GET /styles.css` → `text/css`.
  - Traversal `GET /../server.mjs` (and encoded variants) → 403/404, never
    leaks a file outside webDir.
  - Unknown asset → 404; disallowed extension → 404/403.
  - API precedence: `GET /status` still returns JSON, not a static file.
  - `--web-dir`: start server with a temp web dir containing a sentinel
    `index.html`; assert it is served (proves cwd-independence).
  - Token SSE: a fake `channel` whose `run-turn` calls
    `options.onProgress({ event: 'token', text: 'he' })` then `'llo'`; subscribe
    to `/runs/:id/events`, assert both token events arrive; assert a *later*
    subscriber (after done) does **not** replay the token events (live-only),
    while it still gets `done`.
- `test/model-client.test.mjs`: streaming response via the fake model server
  with two content deltas → `onToken` called twice with the delta text, in
  order; a throwing `onToken` does not break the read (response still returns).
- `test/app.test.mjs`: `--web-dir` parses; `serve` help text mentions the web UI.
- `npm run format`, full `npm test` green (report counts), `npm run check`.

## Live validation (handed to kodr-test-operator, separate)

`kodr serve` from a workspace outside the repo, load the UI in a browser, submit
a real run against a loaded local model, confirm tokens stream into the live
panel via SSE, the run completes, the runs list + `/why` render. Capture a
TEST-REPORT.md. (Unit tests must be green first; this phase is not blocked on the
live run, but the live run is required before marking the web-UI surface
"complete" per AGENTS.md security/surface rule — here the boundary is the static
file handler's traversal guard, which the unit tests cover and the operator
spot-checks.)

## Done criteria

- [x] A: static `serveStaticAsset` fall-through in server.mjs (import.meta.url
      resolution, traversal guard, extension allowlist, content types).
- [x] B: `--web-dir` flag + validation + serve help.
- [x] C: `onToken` through model-client → completeWithContinuations → app.mjs
      `emitProgress({event:'token'})` → registry live-only broadcast → SSE.
- [x] D: `src/web/{index.html,styles.css,app.js}` — new run, live token panel,
      runs list + detail/why, sessions continue, localStorage.
- [x] Tests (server static + token SSE live-only, model-client onToken, app
      flag/help); full suite + format + check green.
- [x] `process/decisions.jsonl` (bundling-by-import.meta.url decision;
      tokens-live-only decision) and/or `process/failures.jsonl`.
- [x] Blog post `blog/134-web-ui.md`.
- [x] NEXT.md: Theme C "Minimal Web UI" section deleted (shipped); version
      bumped to 0.0.134; committed. (Roadmap line added + checked.)
