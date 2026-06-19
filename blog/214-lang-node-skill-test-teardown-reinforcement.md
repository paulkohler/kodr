# Phase 214: lang:node Skill Test Teardown and Port Reinforcement

## The failure that prompted this phase

Phase 212 ran two Node.js dogfooding tasks. Both earned C grades despite the
lang:node skill already containing correct patterns for test teardown and port
handling. The grades were deserved — the code was wrong in ways the skill
explicitly addressed.

Task 1: the model's scratchpad correctly noted "closeAllConnections before
server.close". Then it implemented a subprocess approach instead: `child_process.fork()`
to start the server, `SIGTERM` to stop it. The skill's teardown pattern was
right there, but the model never applied it — it picked a different test
architecture that the skill had no opinion on, so the teardown rules didn't
apply at all.

Task 2: the model needed to read the server port from the environment. The
skill showed `server.address().port` for test port capture. The model read
`process.argv[2]` instead and ignored `process.env.PORT` entirely.

## Why the skill didn't help

The skill contained correct code examples. What it lacked was explicit
prohibition of the alternatives.

For teardown: the skill showed the inline `before`/`after` pattern but said
nothing about subprocess approaches. The model saw "use closeAllConnections"
and "here's how to capture the port" — but only if it had already decided to
write inline tests. Once it chose the subprocess architecture, the teardown
rules became irrelevant. The skill never said "don't use a subprocess in the
first place".

For the port: the skill showed how to capture the OS-assigned port during
testing, but had no section about server startup port parsing. Two different
problems, both under "port", but only one was taught.

## The fix

Two additions to the `## HTTP integration test patterns` section in
`src/builtin-skills/languages/node/SKILL.md`:

**1. An architecture prohibition before the teardown example:**

> Always write integration tests inline with `before`/`after` hooks — never
> use `child_process.fork()`, `spawn()`, or `exec()` to start the server under
> test. Subprocess teardown bypasses `closeAllConnections` and assertion
> failures inside the subprocess don't propagate as test failures.

This makes the no-subprocess rule the first thing in the section. The model
reads it before seeing the teardown code, not after choosing an architecture
that makes the teardown rules irrelevant.

**2. A server-startup port pattern after the dynamic port capture example:**

```js
const port = parseInt(process.env.PORT) || 3000;
server.listen(port, () => { console.log(`Listening on ${port}`); });
```

With a note that `process.env.PORT || 3000` is wrong when PORT is the string
`"0"` (truthy, so 3000 is never reached). The parseInt guard is short and
unambiguous.

## Budget impact

The skill grew. The native-mode budget test in `test/system-env.test.mjs`
had a 5500-char limit; the measured size after the additions is 5849 chars.
The limit was raised to 6100 (measured + ~250 buffer). These limits exist to
catch runaway skill growth, not to enforce a wire constraint — context windows
are 32K+ since phase 146 auto-discovery.

## The underlying pattern

This is the third time a skill addition has followed the same arc:

1. Model produces wrong code.
2. Investigation shows the skill has the right pattern.
3. The model bypassed the skill by choosing an architecture the skill didn't
   address.
4. Add a "never do X" directive to close the bypass.

Phase 207 added pitfall sections for five recurring failures. Phase 214
adds two more. The direction is clear: correct examples aren't enough when
the model can route around them by choosing different starting assumptions.
Explicit negative directives — "never use subprocess teardown", "always
parseInt the env port" — are load-bearing.
