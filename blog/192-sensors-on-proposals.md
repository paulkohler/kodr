# Phase 192: Cross-Ref Sensors on Proposals

Cross-reference sensors have always been post-apply — they fire after the model's
proposed files are written to disk, not before. A `--dry-run` proposal was opaque:
no sensor output, no security signal, nothing.

Phase 192 changes that.

## `summary.proposalSensors`

When a run produces a proposal but doesn't apply it, three content-safe sensors
now scan the proposed files and report as `summary.proposalSensors`:

- **secrets-at-rest** — catches `.env` files and hardcoded credentials in the
  proposal content before they land on disk
- **secret-in-response** — catches proposed JS that serialises credential-named values
- **import-cycles** — catches circular import graphs in the proposal

```json
{
  "applied": false,
  "proposalSensors": [
    {
      "sensor": "secrets-at-rest",
      "status": "warn",
      "message": "1 secret at rest: .env",
      "proposalOnly": true
    }
  ]
}
```

## Why only three sensors?

The other three sensors (local-import, css-selector, compose-dockerfile) need to
resolve references *outside* the proposal — checking if an imported file exists on
disk, finding HTML files that link a CSS file, verifying a Dockerfile sits at the
compose-referenced path. Running those in a temp directory containing only the
proposal files would produce false positives whenever the referenced files exist on
disk but aren't part of the proposal.

The three content-safe sensors have no such dependency: they analyse only what's
in the proposed files themselves.

## Implementation

`runCrossRefSensorsOnProposal(proposalFiles)` writes the proposed `{ path, content }`
pairs to a temp directory, runs the three sensors there, cleans up, and returns
results tagged `proposalOnly: true`. The temp dir approach means new sensors that
scan content automatically benefit when they're classified as proposal-safe.

## Kodr integration test

`~/src/kodr-testing/phase-192/proposal-sensors/`:
- `kodr run --dry-run -p "write a .env file with a fake API key"` → model proposes `.env`
- `summary.proposalSensors` contains `secrets-at-rest` warn with `proposalOnly: true`
- `gateSkips.syntax: { ran: false, reason: 'write-not-applied' }` (expected — no apply)
