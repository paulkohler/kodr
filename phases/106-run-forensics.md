# Phase 106 — Run Forensics As A Product Surface

## Goal

Cash in the transparency already present in run artifacts. Every run already
writes `summary.json`, `writes.json`, `tests.json`, `context.md`, `response.md`
and more. The missing piece was a reader that turns those files into a causal
story: what context was packed and why, what the model proposed, which gate
stopped it, what verification said, and what the stop reason was — with the
artifact paths inline.

## Done criteria

- [x] `src/forensics.mjs` — zero-dependency pure module with:
      - `loadRunAnalysis(runDir)` — reads all relevant artifacts, returns structured object.
      - `buildCausalStory(analysis)` — pure function, returns 7 `StoryStep[]`.
      - `renderForensicsCli(analysis, story)` — ANSI-coloured CLI output.
      - `renderForensicsHtml(analysis, story)` — self-contained HTML, no external deps.
      - `resolveRunDir(cwd, runIdOrPath)` — resolves `.kodr/last-run` fallback.
- [x] `kodr why [run-dir]` CLI command in `src/app.mjs` — uses `last-run` when
      no argument given; supports `--json` flag.
- [x] `GET /runs/:id/why` in `src/server.mjs` — serves the HTML run-viewer page.
- [x] `GET /runs/:id/why.json` in `src/server.mjs` — serves structured JSON
      (story + summary).
- [x] `/why [run-dir]` slash command in `src/tui.mjs` — renders causal story to
      the TUI; falls back to `state.lastRunDir` when no argument given.
- [x] `/why` added to `/help` output in `src/tui.mjs`.
- [x] `test/forensics.test.mjs` — 28 tests across all five exported functions.
- [x] `npm run check` clean, `npm run format` applied.
- [x] `roadmap.md` updated.
- [x] `process/decisions.jsonl` updated.
- [x] Blog post written.

## Story step schema

Each step has:

```
{ phase: string, status: 'ok'|'fail'|'warn'|'skip', detail: string, artifactPath?: string }
```

The 7 canonical phases in order:

1. Context Assembly
2. Model Call
3. Proposal Extraction
4. Edit Application
5. Verification
6. Healing
7. Final Outcome

## Design decisions

1. **`buildCausalStory` is pure** — takes the analysis object, returns step
   array. No I/O. Renderers are separate functions. Testable without disk.
2. **HTML is self-contained** — one string, inline CSS only, no external fonts or
   scripts. Can be opened as a file or streamed from `kodr serve`.
3. **`resolveRunDir` handles three input forms** — absolute path, bare run ID
   (under `.kodr/runs/`), or empty / `"last"` (reads `.kodr/last-run`).
4. **Dynamic import in the TUI** — `/why` uses `await import('./forensics.mjs')`
   to avoid adding a static dependency to the already-large `tui.mjs` startup
   path. The module is cached by Node after the first import.
5. **HTML/JSON routes require a recorded `runDir`** — the server only tracks
   `runDirs` after a run finishes. A `404` with a clear message is returned while
   a run is still active or the run ID is unknown.
6. **XSS escaping in the HTML renderer** — all artifact data goes through `esc()`
   before insertion into the HTML template. Covered by test.
