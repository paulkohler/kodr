import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
	applyResponseFormat,
	plannerResponseFormat,
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

	it('plannerResponseFormat produces a kodr_plan_manifest schema', () => {
		const fmt = plannerResponseFormat();
		assert.equal(fmt.type, 'json_schema');
		assert.equal(fmt.json_schema.name, 'kodr_plan_manifest');
		assert.equal(fmt.json_schema.strict, true);
		assert.ok(Array.isArray(fmt.json_schema.schema.required));
		assert.ok(fmt.json_schema.schema.required.includes('summary'));
		assert.ok(fmt.json_schema.schema.required.includes('files'));
	});
});
