# Phase 30: Subagents

Subagents start as bounded local delegations with explicit request and result artifacts. This keeps the feature replayable and inspectable before introducing model-backed child contexts.

The first concrete subagent is `cycle-review`. It reads a transcript file, compares user-direction-like messages against `AGENTS.md`, and reports candidate instructions that may deserve promotion into the repo process. It does not edit `AGENTS.md`; it writes artifacts and asks the operator to decide.

The command is:

```sh
koder cycle-review --transcript-file chat.md --json
```

Artifacts are written under:

```text
<run-dir>/subagents/cycle-review/request.json
<run-dir>/subagents/cycle-review/result.json
```

This makes the review cycle less dependent on chat memory. User directions that shape future behavior can be surfaced at the right time, reviewed, and then either promoted into `AGENTS.md` or left as one-off context.
