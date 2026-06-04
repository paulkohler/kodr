# Phase 65: Dependency Install Workflow

## Goal

Let Kodr handle dependency installation as a controlled workflow step when an
example or project task explicitly requires a package.

The Phase 52 Express example showed the current gap: Kodr could edit
`package.json`, but the driver had to run `npm install` to materialize
`node_modules` and `package-lock.json`.

## Design

Add a bounded install path for trusted workspace package managers. Mirror the
existing controlled-exec pattern in `src/verification-runner.mjs`
(`parseVerificationCommand`, the spawn allowlist) rather than inventing a new
execution path:

- detect package metadata changes that require installation
- support explicit `npm install`, preferring `npm ci` when a lockfile exists
  (reproducible, offline-friendly)
- record install stdout/stderr as run artifacts
- keep install commands in an allowlist, separate from arbitrary shell execution
- keep generated lockfiles map-only in model context
- keep root format/check scripts from accidentally traversing nested
  `node_modules` trees under examples

### Testing note

`npm install` is networked and non-deterministic, which conflicts with this
repo's offline/local-first test stance. Test the **policy/parse layer** with a
fake command runner (mirroring the Phase 53 fake-command tests), not real
installs.

## Non-Goals

- No arbitrary shell command approval flow.
- No non-Node package managers in the first pass.
- No automatic dependency upgrades beyond what the model explicitly proposes.

## Done Criteria

- [x] Add a controlled dependency install step reusing the allowlist pattern.
- [x] Prefer `npm ci` when a lockfile is present.
- [x] Record install artifacts.
- [x] Keep package manager lockfiles map-only in context.
- [x] Ensure root format/check scripts ignore nested `node_modules`.
- [x] Add tests around install command policy.
- [x] Record decisions and any failures.
- [x] Blog post.
- [x] Mark roadmap complete and commit.
