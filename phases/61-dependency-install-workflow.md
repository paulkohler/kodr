# Phase 61: Dependency Install Workflow

## Goal

Let Kodr handle dependency installation as a controlled workflow step when an
example or project task explicitly requires a package.

The Phase 52 Express example showed the current gap: Kodr could edit
`package.json`, but the driver had to run `npm install` to materialize
`node_modules` and `package-lock.json`.

## Design

Add a bounded install path for trusted workspace package managers:

- detect package metadata changes that require installation
- support explicit `npm install` for the current workspace
- record install stdout/stderr as run artifacts
- keep install commands separate from arbitrary shell execution
- keep generated lockfiles map-only in model context
- keep root format/check scripts from accidentally traversing nested
  `node_modules` trees under examples

## Non-Goals

- No arbitrary shell command approval flow.
- No non-Node package managers in the first pass.
- No automatic dependency upgrades beyond what the model explicitly proposes.

## Done Criteria

- [ ] Add a controlled dependency install step.
- [ ] Record install artifacts.
- [ ] Keep package manager lockfiles map-only in context.
- [ ] Ensure root format/check scripts ignore nested `node_modules`.
- [ ] Add tests around install command policy.
- [ ] Record decisions and any failures.
- [ ] Blog post.
- [ ] Mark roadmap complete and commit.
