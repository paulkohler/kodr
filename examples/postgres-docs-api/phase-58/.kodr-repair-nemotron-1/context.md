## AGENTS.md

<workspace-instructions path="AGENTS.md">
# AGENTS.md

This is a Kodr example workspace. Generate the app here; do not modify files
outside this directory.

## Project Constraints

- Build an API only. Do not create a browser UI.
- Use Node.js 24 ESM.
- Use Express.js for HTTP routing.
- Use the `pg` package for Postgres access.
- Use native `node:test` for tests.
- Use Docker Compose for the Postgres service.
- Keep the API runnable locally outside Docker.
- Keep SQL explicit with migrations. Do not use an ORM.
- Add `.env.example`.
- Add README setup and test instructions.

## Suggested Schema

Use clear table and column names so tests can target stable behavior:

- `users`: `id`, `email`, `display_name`, `created_at`, `updated_at`
- `user_settings`: `user_id`, `theme`, `notifications_enabled`, `created_at`, `updated_at`
- `documents`: `id`, `owner_id`, `title`, `body`, `status`, `created_at`, `updated_at`
- `document_versions`: `id`, `document_id`, `version_number`, `title`, `body`, `created_at`
- `document_tags`: `document_id`, `tag`
- optional `audit_events`: `id`, `actor_user_id`, `action`, `entity_type`, `entity_id`, `created_at`

## API Expectations

Implement at least:

- `GET /health`
- `POST /users`
- `GET /users/:id`
- `PATCH /users/:id/settings`
- `POST /documents`
- `GET /documents`
- `GET /documents/:id`
- `PATCH /documents/:id`
- `DELETE /documents/:id`
- `POST /documents/:id/versions`
- `GET /documents/:id/versions`
- `POST /documents/:id/tags`
- `DELETE /documents/:id/tags/:tag`

Return JSON errors with stable status codes. Keep validation simple and explicit.

## Testing Expectations

Write tests for health, users/settings, document CRUD, versions, and tags.
Tests may assume a Postgres URL from environment. Prefer isolated test data and
cleanup between tests.

</workspace-instructions>

## File map

Workspace files (78 total):
.env.example (153 bytes)
.kodr-repair-1/context.md (80294 bytes)
.kodr-repair-1/conversation.json (88706 bytes)
.kodr-repair-1/messages.json (174 bytes)
.kodr-repair-1/prompt.md (541 bytes)
.kodr-repair-1/raw-request.json (88823 bytes)
.kodr-repair-1/raw-response.json (3741 bytes)
.kodr-repair-1/response.md (526 bytes)
.kodr-repair-1/scratchpad.md (297 bytes)
.kodr-repair-1/summary.json (1309 bytes)
.kodr-repair-1/tasks.json (1038 bytes)
.kodr-repair-1/tests.json (5 bytes)
.kodr-repair-1/writes.json (36 bytes)
.kodr-repair-2/context.md (3342 bytes)
.kodr-repair-2/error.json (89 bytes)
.kodr-repair-2/messages.json (3 bytes)
.kodr-repair-2/prompt.md (547 bytes)
.kodr-repair-2/raw-request.json (6443 bytes)
.kodr-repair-2/raw-response.json (21 bytes)
.kodr-repair-2/response.md (0 bytes)
.kodr-repair-2/scratchpad.md (0 bytes)
.kodr-repair-2/summary.json (879 bytes)
.kodr-repair-2/tasks.json (1004 bytes)
.kodr-repair-2/tests.json (5 bytes)
.kodr-repair-2/writes.json (37 bytes)
.kodr-repair-3/context.md (80956 bytes)
.kodr-repair-3/conversation.json (90737 bytes)
.kodr-repair-3/messages.json (113 bytes)
.kodr-repair-3/prompt.md (372 bytes)
.kodr-repair-3/raw-request.json (90854 bytes)
.kodr-repair-3/raw-response.json (2011 bytes)
.kodr-repair-3/response.md (388 bytes)
.kodr-repair-3/scratchpad.md (220 bytes)
.kodr-repair-3/summary.json (1310 bytes)
.kodr-repair-3/tasks.json (869 bytes)
.kodr-repair-3/tests.json (5 bytes)
.kodr-repair-3/writes.json (36 bytes)
.kodr-repair-4/context.md (4302 bytes)
.kodr-repair-4/error.json (89 bytes)
.kodr-repair-4/messages.json (3 bytes)
.kodr-repair-4/prompt.md (463 bytes)
.kodr-repair-4/raw-request.json (7339 bytes)
.kodr-repair-4/raw-response.json (21 bytes)
.kodr-repair-4/response.md (0 bytes)
.kodr-repair-4/scratchpad.md (0 bytes)
.kodr-repair-4/summary.json (879 bytes)
.kodr-repair-4/tasks.json (916 bytes)
.kodr-repair-4/tests.json (5 bytes)
.kodr-repair-4/writes.json (37 bytes)
.kodr-run/context.md (3225 bytes)
.kodr-run/conversation.json (47831 bytes)
.kodr-run/messages.json (175 bytes)
.kodr-run/prompt.md (432 bytes)
.kodr-run/raw-request.json (47948 bytes)
.kodr-run/raw-response.json (43399 bytes)
.kodr-run/response.md (38843 bytes)
.kodr-run/scratchpad.md (0 bytes)
.kodr-run/summary.json (1308 bytes)
.kodr-run/tasks.json (3918 bytes)
.kodr-run/tests.json (5 bytes)
.kodr-run/writes.json (39347 bytes)
AGENTS.md (1767 bytes)
docker-compose.yml (331 bytes)
migrations/001_init.sql (2366 bytes)
package-lock.json (34738 bytes)
package.json (372 bytes)
prompt.md (432 bytes)
PROVENANCE.md (1597 bytes)
README.md (4957 bytes)
src/app.js (982 bytes)
src/db.js (1039 bytes)
src/migrate.js (1516 bytes)
src/routes/documents.js (7818 bytes)
src/routes/users.js (2816 bytes)
tests/documents.test.js (6987 bytes)
tests/health.test.js (1227 bytes)
tests/users.test.js (2934 bytes)
tests/utils.js (500 bytes)
Use read_file to read any file.
