# Phase 72: Multi-Turn Self-Healing Loop

Take6 finally reached the useful failure: install passed, verification ran, and
the generated app failed because its tests used Jest globals instead of native
`node:test`.

The next repair attempt exposed a second problem. The repair prompt was small,
but the model call stayed alive beyond the configured timeout and left only
partial artifacts. That is not a good repair loop; a failed repair turn needs to
be bounded and inspectable.

Phase 72 adds explicit `--heal` support. After an applied run fails
verification, Kodr can start a bounded repair loop. The repair context is narrow:
it includes `tests.json`, the failing path from the stack trace, and nearby
source such as the sibling implementation file for a failing test.

Each repair turn writes artifacts under `repairs/turn-N/`: prompt, repair
context, response, writes, snapshot diff, tests, and errors when relevant. The
loop stops when verification passes, when the stage budget is exhausted, when
two turns make no workspace progress, when a repair edits a sibling file instead
of the failing path, or when a repair call times out.

This keeps the generated examples honest. Kodr still does not hand-fix the
sample, but it now has the harness machinery to feed real verification failures
back into the model in a controlled way.

Later linkrot testing found a path-normalization edge case in that repair
context. Node stack traces include absolute paths, and the relative-path scanner
could also match the `src/project/...` suffix inside `/Users/.../src/project/...`.
That produced empty phantom context files before the real failing test file. The
repair context now normalizes candidates against the workspace, prefers existing
files, and drops non-existent suffix guesses when the actual failing path is
available.
