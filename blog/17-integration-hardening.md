# Phase 17: Integration Hardening

Phase 17 was added after a focused security review of the completed roadmap.

## Findings

The review found that several primitives were correct in isolation but needed stronger integration boundaries: model-facing reads could escape the workspace, healing applied repairs without an explicit apply gate, loaded skills bypassed context budgets, replay errors were raw, and network fetch blocking needed DNS-aware checks.

## Changes

`read_file`, `--prompt-file`, replay paths, and writes now reuse the same workspace jail. Existing symlink file targets are rejected so reads and writes cannot follow a link outside the repo.

One-shot healing is dry-run by default and only verifies repaired files after explicit apply. Markdown skills now have per-skill and total byte caps, with loaded skills delimited as untrusted workspace Markdown. `fetch_url` rejects resolved private addresses and caps response bodies.

Replay now reports missing and corrupt artifacts with explicit errors. Verification results include the trust boundary: commands are allowlisted and shell-free, but npm scripts are trusted workspace code.

## CLI Honesty

Some later roadmap phases intentionally produced library primitives rather than full product commands. The help text now describes those as implemented primitives instead of future CLI commands.

## Verification

```sh
npm run format
npm test
npm run check
```
