# Phase 159: Wiring the Sensors In

Phase 158 built the sensors. Phase 159 connects them.

`runCrossRefSensors` now runs inside both pipeline paths — the default single-shot
path and the `--subagent-stages` orchestration path — after writes are applied and
after the smoke-check has either passed or been skipped. The results go into
`summary.sensors` (an array of sensor result objects, skipped sensors omitted) and
are rendered as Verification steps by `kodr why`.

The wiring is deliberately parallel to how the smoke-check landed in Phase 156/157:
sensors call their own gate (`runCrossRefSensors`) on the write result, records go
in a dedicated summary field, forensics renders them. The one difference is that
sensors are advisory — a `'warn'` result records and displays, but never flips
`summary.ok`. That's intentional: the CSS-selector sensor in particular may have
false positives against frameworks that generate ids/classes at runtime (React
key props, CSS modules, etc.), and the compose sensor may warn on multi-stage
builds where the Dockerfile is at a non-default path. Real runs will calibrate
which sensors deserve to be promoted to blocking gates.

`kodr why` output for a run that triggered both sensors:

```
✔ ok   Verification  syntax check: 2 files ok
✔ ok   Verification  smoke check: server.mjs loaded ok
⚠ warn Verification  compose-dockerfile warning: docker-compose.yml: build context '.' has no Dockerfile
⚠ warn Verification  css-selector warning: 2 selectors match no element: #add-btn not in index.html; .container not in index.html
```

No model was harmed in the making of these warnings.
