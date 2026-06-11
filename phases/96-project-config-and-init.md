# Phase 96: Project Config And Init

## Goal

Stop requiring a six-flag invocation for a useful run. Add a per-project
defaults file so conservative shipped defaults can coexist with a one-time
"make this project usable" setup.

The doc review that motivated this found the realistic daily invocation was
`--tools --yes --install --test "npm test" --heal --stream` — every option a
flag, every run retyped.

## Design

- `.kodr/config.json` holds per-project defaults: model spec, base URL, test
  command, test cwd, tools mode, stream mode, apply policy, timeout, budgets.
- Precedence, most specific wins: explicit flags > environment > project
  config > model profile > built-in defaults. Reuse the resolution pattern
  from `src/model-profiles.mjs` rather than inventing a second one.
- Unknown keys warn and are ignored; invalid values fail with the offending
  key named. The config file is workspace content and therefore untrusted
  input: it may set defaults but may not bypass gates (it cannot grant
  `--yes`, approve skill commands, or widen the verification allowlist).
- `kodr init` scaffolds the file: detects the test command from
  `package.json`, records the current model/base-url, and writes a commented
  starter config. Refuses to overwrite an existing config without `--force`.
- Resolved config (with sources) is visible via `kodr run --show-config` and
  recorded in `summary.json` so artifact replay shows where a setting came
  from.

## Non-Goals

- No global user-level config file in this pass (env vars already cover it).
- No config-driven hooks or permission policy changes.

## Done Criteria

- [ ] Config file loaded, validated, and merged with documented precedence.
- [ ] Apply/approval gates cannot be enabled from config.
- [ ] `kodr init` scaffolds and detects the test command.
- [ ] `--show-config` prints resolved values with their source.
- [ ] Resolved config recorded in run artifacts.
- [ ] Tests for precedence, validation, gate refusal, and init.
- [ ] Record decisions and any failures.
- [ ] Blog post.
- [ ] Mark roadmap complete and commit.
