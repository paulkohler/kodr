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

- [x] Parse resource metadata from `SKILL.md` frontmatter.
- [x] Include resource indexes in skill listings without loading resource bodies.
- [x] Add bounded, jailed resource loading.
- [x] Add tests for valid resources, missing resources, and path traversal.
- [x] Record decisions and any failures.
- [x] Blog post.
- [x] Mark roadmap complete and commit.

## Result

Kodr now supports `resources:` in `SKILL.md` frontmatter. The parser accepts
simple list entries such as `- path: docs/checklist.md` and scalar shorthand
entries such as `- templates/report.md`.

Skill listings and system prompts include a compact resource index but do not
load resource bodies automatically. In tools mode, models can call
`read_skill_resource` with a skill name/path and a declared resource path. The
loader rejects undeclared resources, missing resources, and resource paths that
escape the skill directory.
