# Phase 21: Markdown Blog Example

The second example app is a Markdown blog generator. It is a step up from the todo CLI because it has structured input, static output, escaping rules, sorting, and tests that inspect generated files.

The local model failed twice while generating this larger example. The first dry run ended with `fetch failed` and no useful run evidence. That exposed a harness gap, so Kodr now writes failure artifacts for model-run failures: `context.md`, `prompt.md`, `summary.json`, `error.json`, empty response/raw-response files, task state, and empty write/test artifacts.

The retry also failed, but this time the run left inspectable evidence at `.kodr/runs/2026-05-26T09-23-40.825Z`. With the harness gap closed, the example was completed manually so the repo still gains the fixture.

The app lives under `examples/markdown-blog`. It uses ESM and Node built-ins, reads Markdown posts with simple frontmatter, renders headings, paragraphs, emphasis, strong text, inline code, fenced code blocks, and links, escapes unsafe HTML, and writes static files into `dist/`.
