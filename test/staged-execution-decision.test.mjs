import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { shouldUseStagedExecution } from '../src/run-pipeline.mjs';

// Phase 229 wiring fix: shouldUseStagedExecution(options, prompt, context),
// combined with `!parent`, produces the `willStage` value that runPrompt passes
// as `inStagedPipeline` to createBuiltinRegistry. The registry's run_command
// pending-write guard reads that flag to choose staged vs envelope steering, so
// this decision must be correct or the guard reverts to envelope wording mid-run
// (the exact regression the phase-229 dogfood caught: a staged run delivered the
// envelope hint because the registry never received the flag).
describe('shouldUseStagedExecution (drives registry inStagedPipeline)', () => {
	const base = { tools: true, yes: true };
	const noAgents = { agents: { content: '' } };

	it('explicit --staged forces staged regardless of prompt terms', () => {
		assert.equal(
			shouldUseStagedExecution(
				{ ...base, staged: true },
				'hello world',
				noAgents,
			),
			true,
		);
	});

	it('explicit --no-staged disables staged even with many trigger terms', () => {
		assert.equal(
			shouldUseStagedExecution(
				{ ...base, staged: false },
				'express api migration with package.json and tests',
				noAgents,
			),
			false,
		);
	});

	it('tools off can never stage (no registry exists)', () => {
		assert.equal(
			shouldUseStagedExecution(
				{ tools: false, yes: true },
				'express api with tests and dependencies',
				noAgents,
			),
			false,
		);
	});

	it('non-apply runs (no --yes) do not stage', () => {
		assert.equal(
			shouldUseStagedExecution(
				{ tools: true, yes: false },
				'express api with tests and dependencies',
				noAgents,
			),
			false,
		);
	});

	it('auto-stages when >= 3 trigger terms appear in the prompt', () => {
		// terms: express, api, test (3) -> staged.
		assert.equal(
			shouldUseStagedExecution(
				base,
				'Build an express api with a test suite',
				noAgents,
			),
			true,
		);
	});

	it('does not auto-stage with < 3 trigger terms', () => {
		// terms: api, test (2) -> not staged. This is the exact shape that left a
		// run single-shot in dogfooding (no "dependencies"/"package.json").
		assert.equal(
			shouldUseStagedExecution(
				base,
				'Build a small REST api with a test file',
				noAgents,
			),
			false,
		);
	});

	it('counts trigger terms from AGENTS.md context, not just the prompt', () => {
		// prompt alone has only "api"; the agents content supplies "docker" + "test".
		assert.equal(
			shouldUseStagedExecution(base, 'Build an api', {
				agents: { content: 'Use docker. Always run the test suite.' },
			}),
			true,
		);
	});
});
