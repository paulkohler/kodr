# Phase 48: Session Export

Phase 48 turns session browsing into a shareable artifact.

`kodr session show <id>` is useful at the terminal, and `--json` is already useful for tooling, but neither is ideal for review notes or a blog post. This phase adds:

```sh
kodr session export <id> --format markdown
```

The Markdown export is deterministic and intentionally plain. It includes the session id, turn count, per-turn model, status, token usage when available, run dir, and fenced user/assistant text. That makes it suitable for saving, diffing, pasting into notes, or using as evidence when diagnosing a model or harness failure.

Only Markdown is supported for now. JSON remains the job of `kodr session show <id> --json`; keeping export narrow avoids a premature format registry.
