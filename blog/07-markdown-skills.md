# Phase 07: Markdown Skills

Phase 07 adds lightweight skill support without adding executable plugin behavior.

## Decision

Support `SKILL.md` files as Markdown instruction documents with simple YAML frontmatter, then let runs load requested skills into the system prompt.

## Design

Kodr discovers `SKILL.md` files deterministically through the same workspace file listing used for context. Frontmatter can provide `name` and `description`; otherwise the containing directory is used as the skill name.

`--show-skills` prints the skill index without calling the model. `--skill NAME_OR_PATH` loads only requested Markdown bodies into the system prompt.

## Why Markdown Only

Executable skill runtimes introduce installation, security, environment, and trust questions. This phase keeps skills as inspectable text so later phases can benefit from reusable instructions without expanding the execution surface.

## Verification

```sh
npm run format
npm test
npm run check
```
