# Phase 66: Skill Resource References

Kodr's first skill implementation was intentionally small: discover `SKILL.md`,
show a compact index, and load selected Markdown instructions into the system
prompt. That kept local-model prompts understandable, but it forced every bit of
specialized guidance into one file.

Phase 66 adds local resource references without changing the safety model.

Skills can now declare resources in frontmatter:

```md
---
name: project-review
description: Project review workflow
resources:
  - path: docs/checklist.md
    description: Review checklist
  - templates/report.md
---
Use the checklist before writing the report.
```

Kodr lists those resources in `--show-skills` and in the available-skills block
of the model prompt, but it does not load the resource bodies automatically. A
tool-enabled model can ask for a specific declared resource with
`read_skill_resource`.

The loader is deliberately strict:

- the resource must be declared by that skill
- the path must stay inside the skill directory
- missing resources fail clearly
- loaded content is byte-capped

This keeps resources useful for references, templates, and examples while
preserving the original Markdown-only boundary. There is still no resource
fetching and no skill code execution. That matters because Skill Code Execution
is intentionally later in the roadmap, after stronger sandbox work.

Tests cover shorthand and object-style resource metadata, skill index rendering,
valid resource reads, missing resources, path traversal, CLI `--show-skills`
output, system prompt exposure, and the `read_skill_resource` native tool.
