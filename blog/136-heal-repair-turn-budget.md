# Phase 136: Room to Fix It

Phase 135 taught the heal loop to read the right channel. The model's captured
`edit_file` calls finally landed on disk instead of being thrown away as an
"invalid proposal." We re-ran the exact qwen task that had exposed the bug, and
this time the repair edits applied, turn after turn. The SyntaxError that broke
the test file moved down the file as the model fixed each occurrence — line 16,
then line 45, then gone.

And still the run ended `max_turns`, not `healed`.

## The wall behind the wall

Fixing the channel uncovered the next constraint, and the artifacts named it
plainly: **every single outer heal turn stopped on `turn_budget_exhausted`**.
Not a model giving up, not a bad edit — the harness pulling the model off the
field mid-repair.

The number was 4. Each heal turn ran an inner tool loop capped at four turns:

```js
maxTurns: Math.min(Math.max(options.maxTurns, 1), 4),
```

Count what a real tool-channel repair costs. The model calls `read_file` to see
the broken test (turn 1). It issues an `edit_file` (turn 2). Another (turn 3).
Another (turn 4). Budget gone — before it can re-read the file it just changed,
before it can run the tests to check its work, before it can react to anything
the harness told it.

And the harness *was* telling it things. Turns two and three produced stale
hunks: `edit_file` calls whose `search` text matched lines that an *earlier*
edit in the same turn had already rewritten. The tool result for each was
correct and helpful — "search text not found, recheck against the current file
content" with the current region quoted back. Exactly the feedback a model needs
to self-correct. But self-correction takes a turn, and there were none left.

## Where the 4 came from

That cap wasn't arbitrary. It was right — for the loop it was written for. When
heal turns were one-shot **envelope** repairs, a turn was a single round trip:
read nothing, emit one JSON proposal, done. Four was generous.

The 117–119 arc inverted the main path to ride the tool-call channel, and phase
135 finally brought healing along with it. But tool-channel repair has a
completely different turn profile. It's a conversation: look, change, check,
adjust. A budget sized for monologue throttles a dialogue. The constant survived
the architecture change that made it wrong, which is the most ordinary way for a
number to go stale — nobody changes a `4` when they change everything around it.

## The fix is the size of the bug

Raise the ceiling from 4 to 8, and pull the expression out of the closure into a
named, tested function so the next person sees a decision instead of a magic
number:

```js
export function healRepairTurnBudget(maxTurns) {
	const requested = Number.isFinite(maxTurns) ? Math.trunc(maxTurns) : 1;
	return Math.min(Math.max(requested, 1), 8);
}
```

Deliberately, this only changes the case that was broken. A default run
(`--max-turns 8`) now gets eight inner repair turns instead of being throttled
to four. Anyone who explicitly asked for a small budget still gets exactly what
they asked for — `healRepairTurnBudget(2)` is still 2. And the ceiling stays
finite so a large `--max-turns` can't turn one heal turn into a runaway. Heal is
already gated to failures only, and the outer loop is still capped at three
passes; this just stops strangling each of those passes at the throat.

## What it doesn't fix

It doesn't make the model write correct hunks. The stale-search drift is real —
a model planning a batch of edits from a single snapshot will trip over its own
earlier changes — and more turns is room to recover, not a cure. That's a
genuinely separate problem (give the model a fresh read between its own edits, or
have it edit against the running draft it's accumulating) and it stays on the
list. But you can't tell whether better edit discipline matters until the model
has the turns to demonstrate it, and until this phase it never did. First give it
room to fix the code. Then find out if it knows how.
