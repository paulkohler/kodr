# Phase 39: Network And Streaming Hardening

Phase 39 is a maintenance phase. No new feature — just five fixes that came out
of a review of the network and streaming code. Each one passed the existing
tests but was wrong (or a trap) under a condition the tests didn't cover. They
are worth writing up because every one of them is a *plausible* bug, not a
contrived one: a redirecting URL, a streamed tool call, a server without a
`/models` route, a prompt that happens to start with `--`.

## 1. The SSRF guard had a hole the size of a redirect

`fetch_url` (the network tool exposed to the model) already did the careful
thing: it parses the URL, rejects `localhost`/loopback/private literals, and
resolves the hostname to make sure it doesn't point at a private address. That
matters because the whole tool surface treats model output as untrusted — the
model can ask to fetch any URL it likes.

The hole: `fetch()` follows redirects by default. So all that validation
applies only to the URL we were *handed*. A model could pass
`https://totally-public.example/`, the guard would clear it, and the server
could answer `302 Location: http://169.254.169.254/latest/meta-data/` — the
cloud metadata endpoint, or any internal address. `fetch` would dutifully follow
it, and the second request was never validated. It's the classic SSRF
redirect bypass.

The fix is blunt and correct: `redirect: 'manual'`, and reject any 3xx response.

```js
const response = await fetchImpl(url, {
  redirect: 'manual',
  signal: AbortSignal.timeout(timeoutMs),
});
if (response.status >= 300 && response.status < 400) {
  throw new ToolError(`Refusing to follow redirect from ${url}`);
}
```

We could have re-run the host validation on each hop instead, but for a
local-first learning tool there's no good reason to follow redirects at all.
Refusing them is the smaller, safer surface. The test injects a `fetchImpl` that
returns a `302` pointing at the metadata IP and asserts both that we throw *and*
that the redirect target is never requested.

## 2. `--stream` silently threw away tool calls

`createChatCompletion` branches on `options.stream`. The streaming branch read
Server-Sent Events and stitched together `delta.content` into a final string —
but it only ever looked at `content`. Tool calls arrive over the stream as
`delta.tool_calls` fragments, and they were dropped on the floor. The
synthesized response had no `tool_calls` and a hard-coded `finish_reason` of
`stop`.

The result: `kodr run --tools --stream` would *look* like it worked, but the
model could never actually call a tool. The harness would see "stop", treat the
empty text as the final answer, and move on. A silent, confusing failure — the
worst kind.

The streamed tool-call protocol is fiddly: the first fragment for a given call
carries the `id` and function `name`, and later fragments append to
`function.arguments` one chunk at a time, addressed by an `index`. So the reader
now accumulates them:

```js
function mergeToolCallFragment(toolCalls, fragment) {
  const index = typeof fragment.index === 'number' ? fragment.index : 0;
  let call = toolCalls[index];
  if (!call) {
    call = { id: '', type: 'function', function: { name: '', arguments: '' } };
    toolCalls[index] = call;
  }
  if (fragment.id) call.id = fragment.id;
  if (fragment.function?.name) call.function.name = fragment.function.name;
  if (fragment.function?.arguments) {
    call.function.arguments += fragment.function.arguments;
  }
}
```

When the stream ends, if any tool calls were collected we surface them on the
synthesized message and report `finish_reason: 'tool_calls'`, so the streaming
path produces the same shape as the buffered path. While in here I also
collapsed the duplicated SSE-parsing logic (the old code had a second copy of
the parse loop just to drain the trailing buffer) into a single `consume`
helper.

## 3. `kodr run` required `/models` even when you named the model

This one I hit in real use. `runPrompt` always called `listModels()` — `GET
/models` — and then used `options.model || firstModelId(...)`. Since there's
always a default model, the discovery result was thrown away in practice, but
the call still happened on every run. Point kodr at an OpenAI-compatible server
that doesn't implement `/models` (plenty of minimal proxies and llama.cpp setups
don't) and every run failed before it ever sent the prompt.

The fix is to only discover when there's something to discover:

```js
if (options.model) {
  model = options.model;
} else {
  const modelsResponse = await listModels(options);
  model = firstModelId(modelsResponse.body);
}
```

`probe` still calls `/models` on purpose — probing the endpoint is its whole
job. But a `run` with a model in hand has no reason to ask. The test queues a
`404` for `/models` and asserts the run still succeeds with exactly one
recorded request: the chat completion.

## 4. `parseArgs` rejected values that start with `--` or are empty

The argument parser guarded value-bearing flags with
`if (!value || value.startsWith('--'))`. The intent was "catch a missing value",
but it also rejected two legitimate inputs: an empty string (`-p ""`) and a
value that happens to start with dashes (`-p "--literal text"`). For a tool
whose main input is a free-form prompt, refusing `--`-prefixed text is a real
limitation.

The correct check is "is there a next token at all":

```js
if (index + 1 >= argv.length) {
  throw new CliError(`${arg} requires a value`);
}
const value = argv[index + 1];
```

The tradeoff is that `kodr run -p --json` now reads `--json` as the prompt rather
than erroring. That's the price of allowing literal `--` values, and it's the
right call for a prompt-driven CLI.

## 5. Streaming discarded `usage`, so budgets couldn't see it

Last one, and it sets up the next phase. The SSE reader never captured the usage
chunk, so a `--stream` run reported zero tokens and couldn't enforce
`--max-tokens` or `--max-cost-usd`. OpenAI-compatible servers only emit usage on
a stream if you ask, so we now send `stream_options: { include_usage: true }`
and carry the final `usage` object onto the synthesized response body — exactly
where `recordUsage` already looks for it.

That capture is only half the story: the totals still aren't *shown* anywhere a
user looks. Surfacing them in `summary.json`, the CLI output, and
`prompt-history` is its own piece of work, which is why it's filed as phase 41
(Token Usage Reporting) rather than crammed in here.

## Live run finding: the harness was right, the persona was wrong

To exercise the streaming changes against a real model (`qwen/qwen3.6-35b-a3b`
in LM Studio) I asked kodr to generate an Express notes API. The harness behaved
exactly as designed: it streamed the response, **captured 22,053 tokens of usage
on the streaming path** (zero before fix #5), skipped `GET /models` because a
model was named (fix #3), extracted the proposal, and stayed in dry-run.

But the proposal came back with `files: []` and a single info message:
> "Reading roadmap.md to identify the first unchecked phase before implementing
> the Express notes API example."

The model wasn't generating an example — it was role-playing *me*. Run inside the
kodr repo, the context pack handed it `AGENTS.md`, including the "Required Loop"
that says read the roadmap and pick the first unchecked phase. The model adopted
the kodr-maintainer persona and tried to follow the workflow instead of writing
the app. This is the same context-pollution failure flagged back in phase 37.

Re-running from a clean temp directory (no `AGENTS.md`, no roadmap in context)
produced the real thing: six files, an `express` dependency in `package.json`,
and a `node:test` suite that **passed all 8 HTTP tests** after `npm install`.

The lesson is about provenance and context, not code: a self-hosting agent repo
is a hostile context for generation runs, because its own process docs read as
instructions to the model. Generation belongs in a clean workspace. (Examples
are also allowed npm dependencies — the built-ins-only rule is for the kodr tool
itself, not the apps it generates.)

## Takeaway

Four of these five passed a green test suite. The lesson that keeps repeating in
this project: tests prove the paths you thought of, and the bugs live in the
paths you didn't — the redirect, the streamed tool call, the missing `/models`
route. A review that asks "what happens if the *other* side misbehaves" found
all of them in an afternoon.
