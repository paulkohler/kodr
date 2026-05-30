# Phase 59: Patch Planning From Inspection

## Goal

Use inspection results to create better pre-edit plans.

The harness should identify likely target files, relevant symbols, nearby tests,
and verification commands before asking the model to produce patches.

## Design

Add a planning step that can produce:

- target files
- target symbols
- related tests
- risk notes
- suggested verification commands

This should connect the structural index to the existing task planning and
workflow machinery.

## Non-Goals

- No automatic patch generation changes unless needed for the plan artifact.
- No external inspector integration.
- No semantic type analysis.

## Done Criteria

- [ ] Add an inspection-derived plan artifact.
- [ ] Include target symbols and related tests when available.
- [ ] Feed the plan into existing task/workflow context.
- [ ] Add tests for plan generation.
- [ ] Record decisions and any failures.
- [ ] Blog post.
- [ ] Mark roadmap complete and commit.
