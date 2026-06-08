import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
	applyResponseFormat,
	proposalResponseFormat,
	responseFormatForRequest,
} from '../src/structured-output.mjs';

describe('structured output request shaping', () => {
	it('omits strict response format for local native tool-call requests', () => {
		const body = {
			messages: [],
			model: 'local-model',
			tools: [{ type: 'function', function: { name: 'list_files' } }],
		};
		const options = {
			provider: 'local',
			responseFormat: proposalResponseFormat(),
		};

		assert.equal(responseFormatForRequest(body, options), null);
		assert.equal(applyResponseFormat(body, options).response_format, undefined);
	});

	it('keeps strict response format for remote tool-call requests', () => {
		const body = {
			messages: [],
			model: 'remote-model',
			tools: [{ type: 'function', function: { name: 'list_files' } }],
		};
		const options = {
			provider: 'openrouter',
			responseFormat: proposalResponseFormat(),
		};

		assert.equal(
			responseFormatForRequest(body, options),
			options.responseFormat,
		);
		assert.equal(
			applyResponseFormat(body, options).response_format,
			options.responseFormat,
		);
	});

	it('keeps strict response format for local requests without tools', () => {
		const body = {
			messages: [],
			model: 'local-model',
		};
		const options = {
			provider: 'local',
			responseFormat: proposalResponseFormat(),
		};

		assert.equal(
			responseFormatForRequest(body, options),
			options.responseFormat,
		);
		assert.equal(
			applyResponseFormat(body, options).response_format,
			options.responseFormat,
		);
	});
});
