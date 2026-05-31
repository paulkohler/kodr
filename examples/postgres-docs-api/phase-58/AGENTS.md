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
