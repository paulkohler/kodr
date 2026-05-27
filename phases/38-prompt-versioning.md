# Phase 38: Prompt Versioning

## Goal

Make prompt iteration traceable. The `prompts/` directory is already a manual
stash of important prompts, but there is no connection between a prompt file and
the run(s) it produced, no diff view between versions, and no way to know whether
a prompt change improved or regressed output quality.

## Design

- Add a `promptId` field to run summaries — a short hash or slug derived from the
  prompt content — so runs can be grouped by prompt.
- Add a `--prompt-id` override flag for named prompts (e.g. `todo-cli-v2`).
- Record `promptId` in `summary.json` for every run.
- Add `kodr prompt-history <promptId>` that lists all runs with that prompt id,
  their models, finish reasons, and eval scores (if present).
- When a `prompts/` file is passed via `--prompt-file`, derive the id from the
  filename so existing prompt stash entries are automatically linked.

## Done Criteria

- [ ] `promptId` derived from content hash and recorded in `summary.json`.
- [ ] `--prompt-id` flag for named overrides.
- [ ] `kodr prompt-history` command with structured output.
- [ ] `--prompt-file` auto-links to `prompts/` filename slug when applicable.
- [ ] Tests cover id derivation, history lookup, and filename linking.
- [ ] Record decisions and any failures.
- [ ] Blog post.
