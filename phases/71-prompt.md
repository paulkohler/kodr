You are editing Kodr itself. This is a self-development acceptance test for
planning, scratchpad carryover, and inspection tool use.

Task: add a derived `totalReferences` field to the object returned by
`inspectWorkspace` in `src/code-inspector.mjs`, and add a matching assertion in
`test/code-inspector.test.mjs`.

Requirements:

- Use `inspect_symbols` and/or `find_references` before writing patches.
- Prefer `read_file` for exact patch context after inspection.
- Use only `patches` for existing files. Do not rewrite full existing files.
- Update `src/code-inspector.mjs` so `index.totalReferences` equals
  `index.references.length`.
- Update the existing `inspectWorkspace` test in `test/code-inspector.test.mjs`
  to assert `index.totalReferences` is a number.
- Include a concise `scratchpad` with plan/done/next notes so a follow-up run can
  continue from it.
- Do not edit roadmap, phase files, blog posts, or process logs.

Return the standard Kodr JSON envelope.
