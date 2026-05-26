# Notes API Example

A small JSON HTTP API used as a Kodr example app.

## Usage

```sh
npm test
NOTES_FILE=./notes.json PORT=3000 npm start
```

## Routes

- `GET /notes`
- `POST /notes` with `{ "title": "...", "body": "..." }`
- `GET /notes/:id`
- `PATCH /notes/:id` with `{ "title": "..." }`, `{ "body": "..." }`, or both
- `DELETE /notes/:id`

Responses are JSON. Notes are persisted to the file selected by `NOTES_FILE`.
