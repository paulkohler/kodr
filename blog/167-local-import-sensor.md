# Phase 167: Local Import-Path Existence Sensor

The most common class of model-write failure: the model writes a file that
imports from a peer it forgot to create. We've been measuring this with the
`js-extract-module` eval fixture since Phase 162. Phase 167 catches it
deterministically at write time, without running any code.

The new `local-import` sensor scans every JS file in the write set for
relative `import`/`export from` specifiers:

```js
import { helper } from './utils.mjs';   // ← relative — check it
import express from 'express';           // ← bare — skip
import path from 'node:path';            // ← built-in — skip
export * from '../lib/index.mjs';        // ← relative — check it
```

For each relative specifier, `resolveLocalImport` checks whether the target
file exists on disk. If the specifier has no extension, it tries appending
`.mjs`, `.js`, `.cjs`, and `/index.{mjs,js,cjs}` — the same resolution
order Node.js uses.

A missing file becomes a sensor `warn`:

```
⚠ local-import         1 unresolved local import: app.mjs imports './missing-module.mjs'
```

It's advisory (not a hard failure) until more real runs calibrate how often
it fires a false positive. But the category of defect it targets — "wrote
a file that imports something that doesn't exist" — is exactly what the
`js-extract-module` eval fixture measures, and it's one of the most common
patterns in local model output.

The sensor runs in parallel with compose-dockerfile and css-selector in
`runCrossRefSensors`. In `kodr check`, it appears in the sensor section;
with `--strict`, a sensor warn becomes a check failure.
