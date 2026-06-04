# Phase 66: Skill Resource References

## Goal

Extend Markdown skills beyond a single `SKILL.md` file by allowing a skill to
declare supporting resource files that Kodr can list and load on demand.

The original Phase 07 skill support deliberately stayed Markdown-only. This
phase keeps that small-model-friendly shape, but lets skills point at local
reference docs, templates, and examples without stuffing all of them into the
system prompt.

## Design

Support standard frontmatter fields in `SKILL.md` for resource metadata:

- `resources`: a list of relative file paths
- optional `description` per resource
- optional `load`: `manual` by default, with room for later automatic loading

Expose resources as a compact index in the skill listing. Add a read-only tool or
existing tool path that can load a named skill resource when the model asks for
it. All paths must stay jailed to the skill directory.

## Non-Goals

- No code execution.
- No remote resource fetching.
- No automatic bulk-loading of every resource.

## Done Criteria

- [ ] Parse resource metadata from `SKILL.md` frontmatter.
- [ ] Include resource indexes in skill listings without loading resource bodies.
- [ ] Add bounded, jailed resource loading.
- [ ] Add tests for valid resources, missing resources, and path traversal.
- [ ] Record decisions and any failures.
- [ ] Blog post.
- [ ] Mark roadmap complete and commit.
