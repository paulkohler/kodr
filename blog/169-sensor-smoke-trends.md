# Phase 169: Smoke and Sensor Stats in `kodr trends`

`kodr trends` now surfaces smoke-check outcomes and sensor warning rates across
the run archive.

```
  smoke check (18 runs with entry):
    ok       15
    failed   2
    skipped  1

  sensor warns (7 runs):
    css-selector             5
    local-import             3
    compose-dockerfile       1
```

Both sections are omitted when no runs have smoke or sensor data (backwards
compatible with pre-156 archives).

The data was already in every `summary.json` (`smokeCheck.status` and
`sensors[].status`). Phase 169 wires it into `computeTrends` so the aggregate
is available in both the CLI report and the raw JSON (`kodr trends --json`).

The sensor warn table answers: "which sensor fires most on real runs?" — which
is exactly the calibration signal needed to decide whether to promote a sensor
from advisory to blocking (or to add a `--no-X` opt-out). Five css-selector
warnings across the archive means the model keeps writing CSS selectors that
match nothing in the HTML.
