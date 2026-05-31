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

Workspace files (41 total):
.env.example (153 bytes)
.kodr-repair-1/context.md (80294 bytes)
.kodr-repair-1/conversation.json (88724 bytes)
.kodr-repair-1/messages.json (180 bytes)
.kodr-repair-1/prompt.md (541 bytes)
.kodr-repair-1/raw-request.json (88857 bytes)
.kodr-repair-1/raw-response.json (3885 bytes)
.kodr-repair-1/response.md (526 bytes)
.kodr-repair-1/scratchpad.md (297 bytes)
.kodr-repair-1/summary.json (1409 bytes)
.kodr-repair-1/tasks.json (1096 bytes)
.kodr-repair-1/tests.json (5 bytes)
.kodr-repair-1/writes.json (38 bytes)
.kodr-run/context.md (3225 bytes)
.kodr-run/conversation.json (47849 bytes)
.kodr-run/messages.json (181 bytes)
.kodr-run/prompt.md (432 bytes)
.kodr-run/raw-request.json (47982 bytes)
.kodr-run/raw-response.json (43543 bytes)
.kodr-run/response.md (38843 bytes)
.kodr-run/scratchpad.md (0 bytes)
.kodr-run/summary.json (1408 bytes)
.kodr-run/tasks.json (4261 bytes)
.kodr-run/tests.json (5 bytes)
.kodr-run/writes.json (39590 bytes)
AGENTS.md (1767 bytes)
docker-compose.yml (331 bytes)
migrations/001_init.sql (2366 bytes)
package-lock.json (34738 bytes)
package.json (391 bytes)
prompt.md (432 bytes)
README.md (4957 bytes)
src/app.js (990 bytes)
src/db.js (1071 bytes)
src/migrate.js (1555 bytes)
src/routes/documents.js (8138 bytes)
src/routes/users.js (2966 bytes)
tests/documents.test.js (7150 bytes)
tests/health.test.js (1247 bytes)
tests/users.test.js (3004 bytes)
tests/utils.js (510 bytes)
Use read_file to read any file.
