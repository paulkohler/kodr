# Phase 07: Markdown Skills

## Goal

Expose simple on-demand Markdown skills to prompts without implementing executable skill runtimes.

## Build Steps

- [ ] Discover `SKILL.md` files deterministically.
- [ ] Parse standard YAML frontmatter when present.
- [ ] Build a system-prompt skill index with name, description, and path.
- [ ] Add explicit skill loading by name or path.
- [ ] Include loaded skill Markdown in the system prompt.
- [ ] Ignore executable hooks, Python runtimes, scripts, and non-Markdown skill behavior.
- [ ] Add `--show-skills`.

## Done Criteria

- [ ] Tests cover deterministic skill discovery.
- [ ] Tests cover frontmatter parsing with and without optional fields.
- [ ] Tests cover loading only requested Markdown skill bodies.
- [ ] Blog post explains why skills are Markdown-only at this stage.

## Notes

This phase supports a lightweight subset of skill behavior: Markdown instruction files plus frontmatter metadata. It should not execute code, install tools, load Python, or interpret arbitrary skill runtimes.
