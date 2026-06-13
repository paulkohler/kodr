# Phase 126: Eight Minutes of Dead Air

Phase 113 taught kodr to give up on a model that never starts talking. If no
token arrives within the first-token deadline, the request aborts and retries
once. It fixed the most common local-model stall — the server accepts the
request and then just... doesn't begin.

But there's a second kind of stall, and phase 113 didn't cover it. The model
*does* start. A chunk or two arrives. Then the stream goes silent — and stays
silent. gemma-4 did this during a validation run: it produced a first chunk on
retry, then hung for the remaining ~480 seconds until the overall request
timeout finally fired. Eight minutes of dead air, watching a cursor blink,
because the only thing governing a mid-stream silence was the whole-request
timeout meant for slow-but-alive generation.

The reason was structural. The read loop applied its deadline as a race between
`reader.read()` and a timer — but only *before the first byte*. After the first
chunk, `firstChunkSeen` flipped true and the loop dropped into a bare
`await reader.read()` with nothing watching the clock. A read that never resolves
just... never resolves.

## A rolling deadline

The fix is an inter-chunk idle deadline: once streaming has begun, no SSE data
for `idleTimeoutMs` fails the turn. The key word is *rolling* — the deadline
resets on every chunk, so it measures the gap since the last token, not a fixed
budget from the start of the stream. A model that streams steadily for two
minutes is fine; a model that streams for two seconds and then flatlines is not.

Implementing it turned the loop's two awkward branches into one. The old code had
a deadline-raced read for the first-token case and a bare read for everything
after. Now there's a single deadline-raced read that picks its deadline and its
error per iteration: the fixed first-token deadline before the first byte, the
rolling idle deadline after. Less code, and the gap that hid the bug is gone by
construction.

## Why it doesn't retry

The first-token timeout retries once — a server that never started might start
on a second try. The idle timeout deliberately does not. By the time it fires,
the model already produced partial output; restarting would re-run generation
from scratch and risk doing the work twice (and paying for it twice, on metered
endpoints). So `InterChunkIdleTimeoutError` is its own error type, it isn't
caught by the retry handler, and it propagates fast with a message that says
exactly what happened: the stream went silent N seconds after the first token.
Fail fast, fail clearly, let the caller decide.

## Testing a silence

The interesting part of testing a stall is producing one deterministically. The
fake model server already had a `stall` mode — send headers, then never send a
body — for the first-token tests. This phase adds `streamThenStall`: send the
given SSE chunk, flush it, then hold the socket open silently forever. That is
the mid-stream stall in miniature, and with a 50ms idle timeout the test
confirms the deadline fires in milliseconds rather than the wall-clock minutes
the real bug took. A second test confirms a normal stream completing inside the
window doesn't trip it — the boring case that has to keep working, verified by a
real gpt-oss run end-to-end through the rewritten loop.

Two stall shapes, two deadlines, one read loop. The model that won't start and
the model that stops mid-sentence now both fail in seconds instead of one in
seconds and the other in eight minutes.
