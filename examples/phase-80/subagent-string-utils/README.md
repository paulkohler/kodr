# string-utils

A tiny Node.js ESM utility package providing simple string manipulation helpers.

## Exported Functions

- **slugifyTitle(value)**  
  Convert a title to a slug: trim, lowercase, replace runs of non‑alphanumeric characters with a single hyphen, and strip leading/trailing hyphens.  
  ```js
  import { slugifyTitle } from 'string-utils';

  console.log(slugifyTitle('Hello World!')); // → 'hello-world'
  ```

- **wordCount(value)**  
  Count the number of whitespace‑separated words in a string. Returns `0` for empty or whitespace‑only strings.  
  ```js
  import { wordCount } from 'string-utils';

  console.log(wordCount('Hello world')); // → 2
  ```

## Installation

This package uses native ESM. Place the files in your project or install via npm (if published).

```bash
npm install string-utils   # if published
```

## Testing

The test suite uses Node.js' built‑in `node:test` runner.

```bash
node --test
```

Make sure you are running Node.js version 18+ which includes native test support.