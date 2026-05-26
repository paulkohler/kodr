Create a small example app under examples/notes-api.

Return only one JSON object with this shape:

{
  "files": [
    {
      "path": "examples/notes-api/package.json",
      "content": "..."
    }
  ]
}

Requirements:

- Use ESM.
- Do not use CommonJS globals such as require, module, or __dirname.
- Use Node.js built-ins only for the server implementation.
- The example app may have its own package.json.
- Provide an HTTP server at src/server.mjs.
- Provide reusable app/store logic at src/app.mjs and src/store.mjs.
- Persist notes to a JSON file.
- Routes:
  - GET /notes
  - POST /notes with JSON body { "title": "...", "body": "..." }
  - GET /notes/:id
  - PATCH /notes/:id with partial JSON body
  - DELETE /notes/:id
- Return JSON responses with appropriate HTTP status codes.
- Validate JSON and note fields.
- Support an environment variable NOTES_FILE for persistence path.
- Add native node:test coverage under test/ using real HTTP requests.
- Add a README.md with usage examples.
- Keep the implementation small and readable.
