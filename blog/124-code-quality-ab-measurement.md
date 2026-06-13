# Phase 124: Measuring the Guidance — and Getting a Null

Phases 121 and 122 built and then refined a block of guidance that tells local
models the Node/ESM rules they keep breaking. Both phases ended on the same
honest admission: *we have not measured whether it helps.* This phase fixes that
— it builds the measurement, runs it, and reports what came back, which was not
what I expected to write.

## The A/B

To measure a prompt addition you need to run the same task twice, identical in
every way except that addition. So phase 124 adds `--no-language-guidance`: a
flag that forces the Node/ESM block off even when the workspace clearly is
Node/ESM. Everything else — detection, tools, the syntax gate, the rest of the
system prompt — stays byte-for-byte the same. The B-arm has the block; the
A-arm doesn't. The run summary records which arm ran (`languageGuidance.source`
present or absent), so the difference is auditable after the fact, not assumed.

The cases live in a new `evals/code-quality.json` suite — greenfield generation
tasks that aim straight at the traps:

- *Create wordcount.mjs* → assert the file exists **and** contains no
  `require(` or `module.exports` (the CommonJS-in-ESM trap).
- *Create sum.mjs and a node:test test* → assert both files exist **and** the
  test contains no `t.assert(` (the invented-API trap).

The `files_exist` half matters more than it looks: `content_absent` is trivially
true for a file that was never written, so without it a model that produces
nothing would "pass" every trap. Pairing the two means a case passes only when
the model wrote the target *and* avoided the trap.

## The result

The arms genuinely differed — I checked the artifacts: B-arm runs carried
`{language:node, source:builtin}` and the contract text in the prompt; A-arm
runs had neither. So the measurement is sound. And the measurement says:

| model           | case        | guidance OFF | guidance ON |
|-----------------|-------------|--------------|-------------|
| gpt-oss-20b     | cq-esm-cli  | clean        | clean       |
| gpt-oss-20b     | cq-nodetest | clean        | clean       |
| devstral-2-2512 | cq-nodetest | clean        | clean       |

Nothing. On these tasks, both models write clean ESM and use the real
`node:test` API whether or not you tell them to. The block changed no outcome
because there was no mistake to prevent.

## Why a null is worth shipping

It would have been easy to write these cases, see green with the guidance on,
and call the guidance vindicated. The A-arm is what stops that — it shows the
green was there *without* the guidance too. That is the entire point of an A/B,
and it just saved me from a false conclusion about a block I added two phases
ago.

The honest reading is sharper than "it works" or "it doesn't": **simple
first-shot generation does not provoke these traps.** Go back to where the traps
actually showed up in the 117–121 record and they are all in messier conditions
— a heal loop working from confusing repair context, larger or multi-file edits,
a model second-guessing itself across turns. The `require.main === module`
habit, the `t.assert()` reach — those came out under pressure, not on a clean
"write me a CLI."

So the measurement infrastructure is the durable win, and it immediately
redirects the next step. The open per-model-family-guidance question can't be
answered on easy cases; it needs **trap-provoking** fixtures — heal-pressure
tasks, edit tasks, the conditions that actually elicited the bugs. Building those
is the next measurement, and now there's a harness waiting to run them through.

## What stays out of scope

Off-by-one logic and wrong-algorithm bugs are still invisible to this kind of
assertion — they need behavioural tests, not pattern checks. And one null across
three runs is a first reading, not a verdict; the value here is the apparatus
plus the redirection, not a settled number.
