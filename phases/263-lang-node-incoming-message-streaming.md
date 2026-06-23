# Phase 263: lang:node IncomingMessage Streaming Pitfall

## Goal

Add a pitfall to the HTTP section of `src/builtin-skills/languages/node/SKILL.md`
explaining that `http.IncomingMessage` has no `.text()` or `.json()` methods —
those belong to the Web Fetch `Request` API.

## Motivation

Phase-252 dogfood: the model wrote `const body = await req.text()` inside an
`http.createServer` handler. `IncomingMessage` is a Node.js readable stream.
The correct pattern is to collect `data` events and call `JSON.parse` on the
concatenated result.

## Work items

- [x] Edit `src/builtin-skills/languages/node/SKILL.md` — add the pitfall block
      to the HTTP integration test patterns section
- [x] Rebuild bundle: `node bin/build-skills.mjs`
- [x] Add test in `test/builtin-skills.test.mjs`:
  - `lang:node warns that IncomingMessage has no .text() or .json()`
  - Assert `/IncomingMessage/`
  - Assert `/req\.text is not a function/`
  - Assert `/req\.on\('data'/`
  - Assert `/Buffer\.concat/`
- [x] Update size guards in `test/system-env.test.mjs` if needed
- [x] `process/decisions.jsonl` entry
- [x] Blog post `blog/263-lang-node-incoming-message-streaming.md`
- [x] Roadmap entry: `- [x] 263 lang:node IncomingMessage Streaming Pitfall`
- [x] Delete NEXT.md candidate entry
- [x] Bump version to `0.0.263`
- [x] Commit

## Done criteria

- [x] All tests green
- [x] `npm run check` passes
- [x] `npm run format` clean
- [x] Pitfall text appears in the built `src/builtin-skills.json`
- [x] Roadmap entry checked
- [x] Blog post written
