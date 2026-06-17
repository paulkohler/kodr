# Phase 190: Secrets-at-Rest Sensor

The pre-commit hook (`kodr hook install`) runs `kodr check --ci`. Until now
that gate caught syntax errors, broken imports, and cycles — but not a `.env`
file the model accidentally committed, or an API key hardcoded in source.

New sensor: `secrets-at-rest`.

```
⚠ secrets-at-rest        1 secret at rest: .env
```

It catches two patterns:

**`.env` files in the write set** — any file named `.env` (or `.env.production`,
`.env.staging`, etc.) triggers a warning. `.env.example` and `.env.sample` are
explicitly excluded (those are meant to be committed).

**Hardcoded credential literals in JS** — patterns like:
```js
const API_KEY = 'sk-prod-abc123xyz456789012345678'; // flagged
const API_KEY = process.env.API_KEY; // ok
const STRIPE_KEY = 'sk_live_...'; // not flagged (name doesn't match)
```

The heuristic requires the variable name to contain a known sensitive term
(`password`, `secret`, `api_key`, `credential`, `private_key`, etc.) AND the
value to be ≥ 24 characters with no whitespace and no placeholder markers
(`your_key_here`, `change_me`, etc.).

Suppress a specific hit with `// kodr-ignore: secrets-at-rest` on the line.

This is sensor 6. It's `error`-severity, so `--strict` (and therefore `--ci`
and the pre-commit hook) will fail when it fires.
