# Phase 23: Notes API Example

The third example app is a small HTTP Notes API. It is more complex than the Markdown blog because it has request routing, JSON parsing, validation, status codes, persistence, and integration tests that make real HTTP requests.

Kodr did produce a valid JSON proposal this time, but it only created `package.json`. The verification command still reported success because `node --test` found zero tests and exited with code 0. That exposed a harness gap: a generated example with no tests should not be considered verified.

The verification runner now marks Node test runs that explicitly report `tests 0` as failed. That keeps `node --check` behavior unchanged while preventing empty test suites from passing example trials.

The final example lives under `examples/notes-api`. It uses Node built-ins, exposes JSON routes for create/list/read/update/delete, validates requests, persists notes to a JSON file selected by `NOTES_FILE`, and has native integration tests using real HTTP requests.
