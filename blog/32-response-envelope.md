# Phase 32: Response Envelope

Kodr's user prompt files were repeating the response schema: return one JSON object, include `files` or `patches`, avoid Markdown fences, and maybe include a scratchpad. That was the wrong layer. The task prompt should describe the work; the harness system prompt should describe the protocol.

The system prompt now defines a response envelope with:

- `status`: `OK` or `ERROR`
- `messages`: short run notes with `level` and `content`
- `files`: full-file write proposals
- `patches`: exact search/replace proposals
- `scratchpad`: private run-local repair notes

Legacy proposal objects without `status` still work and default to `OK`. When the model returns `status: "ERROR"`, Kodr records the messages and marks the run failed without applying writes or running verification.

Run artifacts now include `messages.json`, so user-facing notes are separate from `scratchpad.md`. That gives future tool loops a place to feed back concise status without mixing it into task instructions.

The active Markdown-search prompt fixtures were cleaned up so they describe the requested work and edit style without restating JSON object shapes. Older prompts remain useful historical artifacts, but new prompts should rely on the centralized envelope.

A later 70B Pong experiment exposed two follow-up hardening points. First, model output can contain invalid JSON escapes such as `\'` inside file content; the extractor now repairs those by dropping the unnecessary escape. Second, an apply/test run must not run verification when no proposal was extracted. Kodr now marks that case as a failed run instead of accidentally verifying unrelated workspace tests.
