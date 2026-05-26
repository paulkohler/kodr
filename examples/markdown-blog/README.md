# Markdown Blog Example

A small static blog generator used as a Kodr example app.

## Usage

```sh
npm test
npm run build
```

Posts live in `posts/` and use simple frontmatter:

```md
---
title: My Post
date: 2026-05-26
description: Optional summary
---

# My Post

Markdown content.
```

Generated HTML is written to `dist/`.
