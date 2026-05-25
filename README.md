# koder-by-codex

`koder` is a zero-runtime-dependency coding harness built by Codex for local OpenAI-compatible models, initially LM Studio at `http://localhost:1234/v1`.

The repo is also a learning artifact. Code, tests, decisions, failures, and blog posts should evolve together.

## Constraints

- Node.js 24 or newer.
- ESM only.
- No runtime dependencies.
- Built-in Node modules only.
- Local models first.
- Dry-run before writes.
- Every meaningful decision gets a process note and a blog entry.

## Start

```sh
npm test
./koder --help
```

## Process

Use [roadmap.md](./roadmap.md) as the phase index. Each phase has a spec under [phases/](./phases). Public learning notes live under [blog/](./blog). Small append-only records live under [process/](./process).
