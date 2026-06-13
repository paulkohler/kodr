# Phase 125: A Heal Loop That Remembers the Task

Kodr's strongest guarantee is that status is computed from verification, not
declared by the model. A run is `ok` because the tests passed, not because the
model said so. That guarantee has one seam, and this phase sews it shut.

The seam is the heal loop. When verification fails, kodr re-prompts the model
for a small repair, applies it, and re-runs the tests. If they pass now, the run
is `healed`. Verification is ground truth — which is exactly right, until the
thing that passes isn't the thing that was asked for.

## The false success

Back in phase 113, a greenfield run was asked to write a log-stats CLI. The
model produced nothing extractable. `node --test` found no tests and the
verification "failed", so the heal loop kicked in. But the repair prompt the
loop builds carries only three things: *the previous verification failed*, the
tests JSON, and the failing files. It does **not** carry what was originally
asked. So the repair model, handed an empty workspace and no goal, did the
locally reasonable thing: it invented a trivial module with its own passing
test. Verification went green. The run reported `healed`.

That is goal-substitution, and it is the one way a verification-grounded harness
can still lie: by verifying the wrong goal.

## Two stitches

**Anchor the repair to the task.** The original request now rides in the repair
context and renders as an `## Original task` section in both the loop and
escalation prompts — "The repair must serve this original request; do not solve
a different or simpler problem." It is the cheapest possible fix and the most
obviously correct: the loop was drifting because nothing told it where to go.

**Don't let "produced nothing" become "healed".** A new guard refuses to enter
the heal loop when the original turn wrote zero files *and* verification ran no
tests. That combination isn't a failing suite to repair — it's a generation that
didn't happen. The run is reported honestly (`stopReason: nothing-generated`,
`ok: false`) instead of being handed to a loop that can only invent its way to
green. The guard is deliberately narrow: a real failing suite with zero writes
(legitimate brownfield repair) still heals, because tests ran and failed there.

Both live in `runHealingIfNeeded`, which all three heal paths — standard,
staged, subagent — already funnel through. One change, three paths.

## The bug the fix found

Wiring the write count into the heal entry point meant passing `writeResult` at
each call site. At the staged-execution site that threw immediately:
`writeResult` is block-scoped per stage there, and the aggregate across stages is
`allWrites`. The old code never referenced a stage variable at that point, so the
latent temporal-dead-zone hazard had never fired — until this change tried to
read it. Switching to `allWrites.length` fixed a crash that would have hit any
staged run that reached healing. A reminder that "thread one more field through"
is never quite free, and that the test suite earns its keep on exactly these.

## What it doesn't claim

Forcing a real local model to *need* a repair turn is nondeterministic — gpt-oss
fixed the planted bug on its first attempt in the live check, which is the
normal, healthy path and confirms no regression. The anchoring itself is proven
by a loop test that runs real `node --check` verification and asserts the task
rides in the prompt. And the guard closes the zero-write invent-a-module door;
it does not yet address the subtler case where the model writes *something*
unrelated. That one needs the original-task signal to judge relevance, which is
now in the context — a natural next step, not this phase's claim.
