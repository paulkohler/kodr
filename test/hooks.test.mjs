import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
	createHooks,
	HookBlockedError,
	HookError,
	HookRegistry,
} from '../src/hooks.mjs';

describe('hooks', () => {
	it('runs handlers in order and supports payload mutation', async () => {
		const calls = [];
		const hooks = new HookRegistry()
			.add('pre_tool_use', (payload) => {
				calls.push(`first:${payload.input.path}`);
				return {
					action: 'mutate',
					payload: {
						...payload,
						input: {
							...payload.input,
							path: 'b.txt',
						},
					},
				};
			})
			.add('pre_tool_use', (payload) => {
				calls.push(`second:${payload.input.path}`);
			});

		const result = await hooks.run('pre_tool_use', {
			input: { path: 'a.txt' },
			tool: 'read_file',
		});

		assert.deepEqual(calls, ['first:a.txt', 'second:b.txt']);
		assert.equal(result.payload.input.path, 'b.txt');
		assert.deepEqual(
			result.decisions.map((decision) => decision.action),
			['mutate', 'allow'],
		);
	});

	it('blocks with structured decisions', async () => {
		const hooks = createHooks({
			pre_tool_use: [
				() => ({ note: 'observed' }),
				() => ({ action: 'block', reason: 'No writes here.' }),
			],
		});

		await assert.rejects(
			() => hooks.run('pre_tool_use', { input: {}, tool: 'write_file' }),
			(error) => {
				assert.equal(error instanceof HookBlockedError, true);
				assert.equal(error.message, 'No writes here.');
				assert.deepEqual(
					error.details.decisions.map((decision) => decision.action),
					['allow', 'block'],
				);
				return true;
			},
		);
	});

	it('rejects invalid handlers and decisions', async () => {
		assert.throws(() => new HookRegistry().add('', () => {}), HookError);
		assert.throws(() => new HookRegistry().add('x', 'nope'), HookError);

		const hooks = createHooks({
			pre_tool_use: [() => ({ action: 'mutate' })],
		});

		await assert.rejects(
			() => hooks.run('pre_tool_use', { input: {}, tool: 'read_file' }),
			HookError,
		);
	});
});
