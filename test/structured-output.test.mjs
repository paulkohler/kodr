import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
	applyResponseFormat,
	plannerResponseFormat,
	proposalResponseFormat,
	responseFormatForRequest,
} from '../src/structured-output.mjs';

describe('structured output request shaping — profile mode', () => {
	it('mode none: never attaches response_format regardless of tools', () => {
		const body = {
			messages: [],
			model: 'local-model',
			tools: [{ type: 'function', function: { name: 'list_files' } }],
		};
		const options = {
			structuredOutputMode: 'none',
			responseFormat: proposalResponseFormat(),
		};

		assert.equal(responseFormatForRequest(body, options), null);
		assert.equal(applyResponseFormat(body, options).response_format, undefined);
	});

	it('mode none: removes existing response_format from body', () => {
		const body = {
			messages: [],
			model: 'local-model',
			response_format: { type: 'json_schema', json_schema: { name: 'x' } },
		};
		const options = { structuredOutputMode: 'none' };

		const result = applyResponseFormat(body, options);
		assert.equal(result.response_format, undefined);
	});

	it('mode json_schema: attaches the schema for any turn type', () => {
		const body = {
			messages: [],
			model: 'remote-model',
			// Final turn: no tools in body
		};
		const fmt = proposalResponseFormat();
		const options = {
			structuredOutputMode: 'json_schema',
			responseFormat: fmt,
		};

		assert.equal(responseFormatForRequest(body, options), fmt);
		assert.equal(applyResponseFormat(body, options).response_format, fmt);
	});

	it('mode json_schema with tools: attaches schema (no heuristic suppression)', () => {
		const body = {
			messages: [],
			model: 'remote-model',
			tools: [{ type: 'function', function: { name: 'list_files' } }],
		};
		const fmt = proposalResponseFormat();
		const options = {
			structuredOutputMode: 'json_schema',
			provider: 'openrouter',
			responseFormat: fmt,
		};

		assert.equal(responseFormatForRequest(body, options), fmt);
		assert.equal(applyResponseFormat(body, options).response_format, fmt);
	});

	it('mode json_schema: forced final turn body (no tools) gets same schema as main turn', () => {
		// S2: the forced final turn drops tools from the body. This test asserts
		// the schema attaches regardless — same contract on every turn type.
		const mainBody = {
			messages: [],
			model: 'remote-model',
			tools: [{ type: 'function', function: { name: 'list_files' } }],
		};
		const finalBody = {
			messages: [],
			model: 'remote-model',
			// tools omitted — this is the forced final turn
		};
		const fmt = proposalResponseFormat();
		const options = {
			structuredOutputMode: 'json_schema',
			responseFormat: fmt,
		};

		const mainFormat = responseFormatForRequest(mainBody, options);
		const finalFormat = responseFormatForRequest(finalBody, options);
		assert.deepEqual(mainFormat, finalFormat);
		assert.equal(finalFormat, fmt);
	});

	it('mode json_object: attaches json_object format', () => {
		const body = { messages: [], model: 'some-model' };
		const options = { structuredOutputMode: 'json_object' };

		const result = applyResponseFormat(body, options);
		assert.deepEqual(result.response_format, { type: 'json_object' });
		assert.deepEqual(responseFormatForRequest(body, options), {
			type: 'json_object',
		});
	});

	it('legacy fallback: local provider without mode → none behavior', () => {
		// Call sites that pre-date profile threading still get local=none behavior.
		const body = { messages: [], model: 'local-model' };
		const options = {
			provider: 'local',
			responseFormat: proposalResponseFormat(),
		};

		assert.equal(responseFormatForRequest(body, options), null);
		assert.equal(applyResponseFormat(body, options).response_format, undefined);
	});

	it('legacy fallback: non-local provider without mode + responseFormat → json_schema behavior', () => {
		const body = { messages: [], model: 'remote-model' };
		const fmt = proposalResponseFormat();
		const options = {
			provider: 'openrouter',
			responseFormat: fmt,
		};

		assert.equal(responseFormatForRequest(body, options), fmt);
		assert.equal(applyResponseFormat(body, options).response_format, fmt);
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
