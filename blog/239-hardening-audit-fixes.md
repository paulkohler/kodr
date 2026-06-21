# Phase 239: Hardening The Existing System

Phase 239 started with a full review rather than a feature request. The useful
result was not a list of stylistic preferences; it was a set of boundary failures
that small, happy-path unit tests had allowed to coexist with high aggregate
coverage.

## The local server was reachable from the web

`kodr serve` bound to loopback, but it accepted any `Host`, ignored `Origin`, and
parsed JSON from any content type. A cross-origin `text/plain` POST containing
`{"prompt":"...","yes":true,"tools":true}` reached the shared run channel.

That combination matters because `text/plain` is a CORS-safelisted content type:
a hostile page can send the request without a preflight. Arbitrary Host handling
also leaves the server open to DNS-rebinding-shaped requests.

The server now checks that Host names the actual local listener, requires an
Origin (when present) to match that exact origin, and accepts JSON bodies only as
`application/json`. Regression tests exercise hostile origins, a different local
origin, an attacker Host, and the original text/plain request. The underlying
semantics come from the [WHATWG Fetch Standard](https://fetch.spec.whatwg.org/#cors-safelisted-request-header).

## DNS validation must control the connection

`fetch_url` resolved a hostname, rejected private results, and then called
`fetch()`. The actual request performed a second DNS resolution. Validation and
connection therefore did not refer to the same address.

The replacement uses Node's `http.request` / `https.request` and supplies a
custom `lookup` that returns the address already checked by Kodr. Private IPv4,
IPv4-mapped IPv6, unique-local, link-local, multicast, and reserved ranges are
rejected; redirects remain disabled and bodies remain capped. Node documents the
custom lookup hook in its [HTTP API](https://nodejs.org/api/http.html).

The first real HTTPS probe found a detail the mock did not: Node can request
`lookup` results with `all: true`, which requires an array result. After supporting
both callback shapes, a pinned request to `https://example.com` returned 200 with
the expected bounded body. That failure is recorded because it is exactly why
security-boundary work needs a real integration check.

## Untrusted model output needs a byte budget

Token and timeout budgets did not bound raw HTTP input. A provider could send an
unlimited JSON body, SSE framing buffer, text completion, or streamed tool-call
argument. Kodr now applies a 16 MiB default ceiling before parsing. Both transport
modes cancel or destroy the response after the limit, and tests cover ordinary
content plus large tool arguments.

## The Node skill taught the wrong mechanism

The builtin skill said query strings were ignored for local ESM files. Node's
documentation says the opposite: ES modules are cached by URL and different
queries load separate instances. A Node 24 runtime probe confirmed it. See the
[Node 24 ESM documentation](https://nodejs.org/download/release/v24.1.0/docs/api/esm.html#file-urls).

The observed test contamination was consistent with `Date.now()` producing the
same query more than once, not with Node ignoring the query. The recommendation
to use factories was still good—timestamps are not guaranteed unique and unique
module URLs accumulate for the process lifetime—but the explanation was false.
The new regression test imports two query variants, proves they are different
instances, and proves the repeated query returns the same instance.

## Coverage did not imply test stability

The default parallel suite failed one healing behavior test while the same test
passed repeatedly alone. Its initial `node --check` had a one-second deadline.
Under load the process sometimes timed out before printing the failing filename,
which changed the state machine input and therefore the stop reason.

The behavior test now uses a ten-second command deadline. The first full-suite
rerun exposed the same one-second assumption in the bounded-tools behavior
test, so that deadline was corrected too. Dedicated timeout tests still use
short clocks. The distinction is important: only timeout tests should depend on
scheduler timing.

## Smaller seams, same pipeline

The review also found renewed concentration. This phase did not rewrite the core
state machine while changing its security boundaries. It made three lower-risk
splits instead:

- CLI help moved from `cli/args.mjs` to `cli/usage.mjs`.
- Human run rendering moved from `run-pipeline.mjs` to `run-summary.mjs`.
- Staged integration coverage moved from the 9,692-line `app.test.mjs` into a
  focused `staged-pipeline.test.mjs`.

The architecture document was replaced with a current assessment. It explicitly
names the still-large `runPrompt`, `runStagedPrompt`, and `parseArgs` state
machines as follow-up decomposition work rather than pretending the earlier split
finished the job.

## User contracts repaired

The README, usage guide, and CLI help still described dry-run or prompting as the
default even though `run` and `tui` apply and test by default. The documents now
agree with the implementation: `--dry-run` previews, `--confirm` restores the TTY
prompt, and JSON/HTTP remain dry unless apply is explicit.

Explicit `--skill lang:node` now falls through to the builtin registry when no
workspace skill matches. Workspace/project precedence remains unchanged.

The phase is a useful reminder: hardening is not a separate polish pass. It is
the work of making trust boundaries, documentation, tests, and internal seams all
describe the same system.
