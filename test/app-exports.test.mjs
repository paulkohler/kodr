import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import * as app from '../src/app.mjs';

// Phase 148 guard: app.mjs is being split into a thin dispatcher + modules, with
// moved symbols re-exported from app.mjs so the public import surface (13 test
// files + channel handlers) stays stable. This test pins that surface: if a
// future extraction stage moves a symbol without re-exporting it, this fails
// loudly instead of breaking importers elsewhere.
describe('app.mjs public export surface (phase 148 re-export barrel)', () => {
	const expectedFunctions = [
		'parseArgs',
		'usage',
		'main',
		'runPrompt',
		'handleChannelRequest',
		'parseManagementInstances',
		'extractPromptFilePaths',
		'renderSessionList',
		'renderSessionConversation',
		'renderSessionMarkdown',
		'renderSkillsListing',
	];

	for (const name of expectedFunctions) {
		it(`exports ${name} as a function`, () => {
			assert.equal(
				typeof app[name],
				'function',
				`app.mjs must (re-)export ${name}`,
			);
		});
	}

	const expectedClasses = ['CliError', 'NativeNoProposalError'];
	for (const name of expectedClasses) {
		it(`exports ${name} as a class`, () => {
			assert.equal(typeof app[name], 'function', `app.mjs must export ${name}`);
			assert.ok(
				app[name].prototype instanceof Error || app[name] === Error,
				`${name} should be an Error subclass`,
			);
		});
	}
});
