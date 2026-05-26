# Phase 07: Markdown Skills

## Goal

Expose simple on-demand Markdown skills to prompts without implementing executable skill runtimes.

## Build Steps

- [x] Discover `SKILL.md` files deterministically.
- [x] Parse standard YAML frontmatter when present.
- [x] Build a system-prompt skill index with name, description, and path.
- [x] Add explicit skill loading by name or path.
- [x] Include loaded skill Markdown in the system prompt.
- [x] Ignore executable hooks, Python runtimes, scripts, and non-Markdown skill behavior.
- [x] Add `--show-skills`.

## Done Criteria

- [x] Tests cover deterministic skill discovery.
- [x] Tests cover frontmatter parsing with and without optional fields.
- [x] Tests cover loading only requested Markdown skill bodies.
- [x] Blog post explains why skills are Markdown-only at this stage.

## Notes

This phase supports a lightweight subset of skill behavior: Markdown instruction files plus frontmatter metadata. It should not execute code, install tools, load Python, or interpret arbitrary skill runtimes.
