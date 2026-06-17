# Phase 188: Sensor Severity Levels

`--strict` used to be a blunt instrument: every sensor warning became a failure.
That meant a missing Dockerfile in a WIP compose file would fail CI — which is
often wrong. But a missing import module always crashes Node, so that should
always fail.

Now sensors carry a `severity`:

| Sensor | Severity | Rationale |
|---|---|---|
| `compose-dockerfile` | `warning` | Missing Dockerfile may be intentional |
| `css-selector` | `warning` | Dead selectors don't crash |
| `local-import` | `error` | Missing module crashes at import time |
| `import-cycles` | `error` | Produces `undefined` exports at runtime |
| `secret-in-response` | `error` | Security concern |

`--strict` now only promotes `error`-severity warns to failures.
`warning`-severity sensors are still shown, but they don't break the build.

Every `warn` result in `--json` output now includes the `severity` field too,
so downstream CI tooling can sort by it.
