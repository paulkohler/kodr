# Example Apps

These examples are small target apps for exercising Kodr against different project shapes.

Each example should be treated as a Kodr sample, not just a hand-written fixture. If one-shot generation fails or produces an incomplete app, the next step is to update the harness or split the work into smaller Kodr prompts, then record the run artifacts in the example provenance.

## Candidates

- CLI todo app: commands for adding, listing, completing, and deleting todos with JSON file persistence.
- Markdown blog generator: converts `posts/*.md` into static HTML under `dist/`.
- Express notes API: REST endpoints for notes with request validation and HTTP tests.
- CSV expense analyzer: reads CSV files, groups spending by month and category, and emits reports.
- SQLite habit tracker: tracks daily habit completion with migrations and persistence tests.
- Local Markdown search app: indexes Markdown files and searches them with a ranking dependency.
- Postgres documents API: Express.js API backed by Docker-hosted Postgres with users, settings, documents, versions, tags, and integration tests.
- React Kanban board: a Vite app with columns, cards, and local persistence.

## First Trial

The first trial is the CLI todo app because it is the smallest useful app and can be verified with fast Node tests.

## Second Trial

The second trial is the Markdown blog generator because it adds structured parsing, static output, escaping, and generated-file tests without needing a server or browser.

## Third Trial

The third trial is the Notes API because it adds HTTP routing, JSON validation, persistence, status codes, and integration tests with real requests.

## Fourth Trial

The fourth trial is the CSV expense analyzer because it adds quoted text parsing, validation, aggregation, and command-line reporting.

## Fifth Trial

The fifth trial is the Local Markdown search app because it adds untrusted document content, indexing, ranking, snippets, CLI output, and naturally subagent-shaped work.

## Sixth Trial

The sixth trial is the Postgres documents API under [`postgres-docs-api/phase-58`](./postgres-docs-api/phase-58). It is intentionally more realistic than the earlier examples: Express.js, Postgres through Docker Compose, migrations, integration tests, environment configuration, and several related REST resources.

This trial should stress Kodr's ability to plan and modify a multi-file service, manage package installation needs, handle generated lockfiles sensibly, and recover from database/test setup failures. The seed workspace includes an `AGENTS.md` so Kodr receives stable local guidance without overloading the user prompt.
