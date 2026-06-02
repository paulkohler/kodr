import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { completeWithContinuations } from '../src/completion.mjs';
import { createHooks } from '../src/hooks.mjs';
import { startFakeModelServer } from '../test-support/fake-model-server.mjs';

describe('completeWithContinuations', () => {
	it('replaces blocked stop responses instead of concatenating them', async () => {
		let stopCalls = 0;
		const server = await startFakeModelServer({
			responses: [
				{
					body: {
						choices: [
							{
								finish_reason: 'stop',
								message: { content: 'Blocked answer.', role: 'assistant' },
							},
						],
						id: 'chatcmpl_blocked',
						object: 'chat.completion',
					},
					method: 'POST',
					status: 200,
					url: '/v1/chat/completions',
				},
				{
					body: {
						choices: [
							{
								finish_reason: 'stop',
								message: { content: 'Corrected answer.', role: 'assistant' },
							},
						],
						id: 'chatcmpl_corrected',
						object: 'chat.completion',
					},
					method: 'POST',
					status: 200,
					url: '/v1/chat/completions',
				},
			],
		});

		try {
			const completion = await completeWithContinuations(
				{
					baseUrl: server.baseUrl,
					extraHeaders: {},
					hooks: createHooks({
						stop: [
							() => {
								stopCalls += 1;
								return stopCalls === 1
									? { action: 'block', reason: 'lint failed' }
									: {};
							},
						],
					}),
					maxCostUsd: '',
					maxRetries: 7,
					maxTokens: '',
					maxTurns: 8,
					stream: false,
					timeoutMs: 5000,
				},
				'test-model',
				'Write answer.',
				'You are helpful.',
			);

			assert.equal(completion.text, 'Corrected answer.');
			assert.deepEqual(completion.finishReasons, ['stop', 'stop']);
			assert.match(
				server.recordings[1].requestBody.messages.at(-1).content,
				/lint failed/u,
			);
		} finally {
			await server.close();
		}
	});
});
