# Phase 77: TUI ANSI Color

## Goal

Add small, zero-dependency ANSI color support to `kodr tui` so interactive
turns are easier to scan without changing the plain CLI or JSON surfaces.

The first target is simple readability: info/status messages can be dim gray,
errors red, warnings yellow, success green, and prompts or command labels cyan
or bold.

## User Surface

No new command is required.

```sh
kodr tui
kodr tui --session <id>
kodr tui --continue
```

Color should be automatic for interactive terminals and disabled for
non-interactive output.

Optional environment controls:

- `NO_COLOR`: disable ANSI color.
- `FORCE_COLOR=1`: force ANSI color.

## Design

Add a small `src/ansi.mjs` helper using raw ANSI escape codes and no
dependencies.

Suggested helpers:

- `bold(text)`
- `dim(text)`
- `gray(text)`
- `green(text)`
- `red(text)`
- `yellow(text)`
- `cyan(text)`
- `stripAnsi(text)` for tests
- `createAnsi({ isTty, env })` or equivalent policy wrapper

Color policy:

- enable when the target stream is a TTY
- disable when `NO_COLOR` is present
- force when `FORCE_COLOR=1` is present
- keep `--json`, normal non-TUI CLI output, and artifact files uncolored

## TUI Mapping

Initial color roles:

- info/status lines: dim gray
- successful run/test/apply messages: green
- errors and failed tests: red
- warnings, pending reviews, and unapplied writes: yellow
- user prompt marker and slash command labels: cyan or bold
- assistant streamed content: plain by default

The formatter should sit close to the TUI presentation layer. The shared
channel/request layer should stay color-agnostic.

## Tests

Use native `node:test`.

Cover:

- ANSI helpers wrap text only when color is enabled.
- `stripAnsi` removes color codes.
- TUI output is colored when `isTTY` or `FORCE_COLOR=1` enables color.
- TUI output is plain when `NO_COLOR` is set or output is not a TTY.
- JSON/non-interactive output remains plain.

## Non-Goals

- No dependency on Chalk, kleur, or similar packages.
- No full theme system.
- No terminal capability database.
- No color in machine-readable artifacts.
- No changes to model prompts or channel payloads.

## Risks

- Tests can become brittle if they assert whole colored transcripts. Prefer
  targeted assertions around role-specific fragments.
- Color should not hide meaning. Every colored message must remain meaningful
  when ANSI is disabled.
- Some terminals render dim gray poorly. Keep the palette conservative.

## Done Criteria

- [x] Add zero-dependency ANSI helper.
- [x] Add color policy for TTY, `NO_COLOR`, and `FORCE_COLOR`.
- [x] Apply colors to TUI status, success, warning, error, and prompt roles.
- [x] Keep shared channel responses and JSON output color-free.
- [x] Add native tests for helper and TUI output policy.
- [x] Run `npm run format`.
- [x] Run tests.
- [x] Run `npm run check`.
- [x] Update process logs if implementation choices or failures are notable.
- [x] Add or update the matching blog post.
