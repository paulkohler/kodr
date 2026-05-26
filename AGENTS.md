# AGENTS.md

This repo is built as a learning tool. Preserve the process, not just the code.

## Rules

- Use Node.js 24 built-ins only.
- Keep ESM.
- Add native `node:test` coverage for each feature.
- Prefer small commits.
- Keep model endpoints OpenAI-compatible and local-first.
- Default LM Studio base URL: `http://localhost:1234/v1`.
- Default model timeout: `600000ms`.
- Treat model output as untrusted.
- Default file writes to dry-run until explicit apply behavior exists.

## Required Loop

1. Read `roadmap.md`.
2. Pick the first unchecked phase.
3. Read the matching `phases/NN-name.md`.
4. Implement only that phase.
5. Add or update tests.
6. Run `npm run format`.
7. Run tests.
8. Run `npm run check`.
9. Update `process/decisions.jsonl` and `process/failures.jsonl` when relevant.
10. Add or update the matching blog post.
11. Mark phase checklist items done.
12. Commit.
13. Review the work and upcoming phases for bugs, plan drift, or better sequencing.
14. Commit any review-driven process or roadmap adjustments before moving on.

Failures are valuable. Record symptoms, likely causes, and fixes.
