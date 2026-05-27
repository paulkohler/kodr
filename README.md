# koder-by-codex

`koder` is a zero-runtime-dependency coding harness built by Codex for local OpenAI-compatible models, initially LM Studio at `http://localhost:1234/v1`.

The repo is also a learning artifact. Code, tests, decisions, failures, and blog posts should evolve together.

## Constraints

- Node.js 24 or newer.
- Biome is expected to be installed globally for formatting and uses the repo `biome.jsonc`.
- ESM only.
- No runtime dependencies.
- Built-in Node modules only.
- Local models first.
- Dry-run before writes.
- Every meaningful decision gets a process note and a blog entry.

## Start

```sh
npm test
npm run format
./koder --help
```

## Process

Use [roadmap.md](./roadmap.md) as the phase index. Each phase has a spec under [phases/](./phases). Public learning notes live under [blog/](./blog). Small append-only records live under [process/](./process).

## Examples

Small harness trial apps live under [examples/](./examples). The first example is a generated CLI todo app with its own package and tests under [examples/todo-cli](./examples/todo-cli).

## Run Artifacts

Each `koder run` writes inspectable artifacts under `.koder/runs/...`, including packed context, proposal messages, raw model responses, proposed writes, verification results, and `tasks.json`. The task plan makes the harness' todo list explicit for replay and later repair loops.

## Security Boundaries

Kodr treats model output, workspace files, `AGENTS.md`, `SKILL.md`, replay artifacts, and fetched network content as untrusted input. File reads and writes are jailed to the workspace, model-proposed writes stay dry-run until `--yes`, and Markdown skills are byte-capped before entering the system prompt.

Verification commands are allowlisted and run without a shell, but `npm test` and `npm run test` still execute trusted workspace package scripts. Safe writes create backups for existing files before applying changes; they are controlled writes with backups, not full rollback transactions.
