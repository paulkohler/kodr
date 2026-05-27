# Initial Build Prompt

You are Codex building `kodr` from this clean repo.

Goal: build a zero-runtime-dependency Node.js 24 coding harness for local OpenAI-compatible models, initially LM Studio at `http://localhost:1234/v1`.

Hard constraints:

- Use only Node built-in libraries.
- Use ESM.
- Add native `node:test` coverage for every feature.
- Make small commits.
- Every commit needs terse process notes.
- Every meaningful decision or failure needs a blog entry.
- Prefer observable artifacts over hidden state.
- Default model timeout is `600000ms`.
- Default to dry-run for filesystem writes.
- Treat model output as untrusted.

Process:

1. Read `roadmap.md`.
2. Pick the first unchecked phase.
3. Read the matching phase file.
4. Implement only that phase.
5. Add tests.
6. Run tests.
7. Update process logs and blog notes.
8. Mark the phase done.
9. Commit.

Start with Phase 02: LM Studio Probe.
