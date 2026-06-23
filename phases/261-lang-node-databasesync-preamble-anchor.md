# Phase 261: lang:node DatabaseSync Preamble Anchor

## Goal

Add a one-liner anchor to the preamble of `src/builtin-skills/languages/node/SKILL.md`
that names the correct `node:sqlite` import at the top of every Node/ESM prompt,
regardless of whether the SQLite gate section fires.

## Motivation

Despite a full `## Import Name` pitfall in `lang:sqlite`, the model still writes
`import { Database } from 'node:sqlite'` on cold runs because the SQLite section is
gated and long — the import pitfall is buried deep inside it. Phase 256 proved preamble
placement works: putting the hook-async pitfall in the preamble successfully prevented
done-callback usage. The same approach should anchor DatabaseSync.

Provenance: persistent dogfood failure across phases 255/256/258.

## Work Items

- [x] Edit `src/builtin-skills/languages/node/SKILL.md` — add DatabaseSync anchor to the preamble
- [x] Rebuild bundle: `node bin/build-skills.mjs`
- [x] Add test in `test/builtin-skills.test.mjs`
- [x] `process/decisions.jsonl` entry
- [x] Blog post `blog/261-lang-node-databasesync-preamble-anchor.md`
- [x] Roadmap entry
- [x] Version bump to `0.0.261`
- [x] Commit

## Done Criteria

- [x] `getBuiltinSkill('lang:node').body` matches `/DatabaseSync/` before the first `\n## `
- [x] `getBuiltinSkill('lang:node').body` matches `/import \{ DatabaseSync \} from 'node:sqlite'/`
- [x] `npm test` green
- [x] `npm run check` passes
