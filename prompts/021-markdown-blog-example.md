Create a small example app under examples/markdown-blog.

Return only one JSON object with this shape:

{
  "files": [
    {
      "path": "examples/markdown-blog/package.json",
      "content": "..."
    }
  ]
}

Requirements:

- Use ESM.
- Do not use CommonJS globals such as require, module, or __dirname.
- The example app may have its own package.json.
- Dependencies are allowed for this example, but prefer a small dependency set.
- Provide a build script at src/build.mjs.
- Provide reusable Markdown/blog logic at src/blog.mjs.
- Read Markdown posts from posts/.
- Support YAML-like frontmatter with title, date, and optional description.
- Generate static HTML files into dist/.
- Generate dist/index.html listing posts sorted by date descending.
- Escape unsafe HTML in post content and metadata.
- Support at least headings, paragraphs, emphasis, strong text, inline code, fenced code blocks, and links.
- Add sample posts under posts/.
- Add native node:test coverage under test/.
- Add a README.md with usage examples.
- Keep the implementation small and readable.
