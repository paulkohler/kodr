import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { completeWithContinuations } from '../src/completion.mjs';
import { createHooks } from '../src/hooks.mjs';
import { startFakeModelServer } from '../test-support/fake-model-server.mjs';

// Build a Server-Sent Events body from a list of chunk objects.
function sse(chunks) {
	const events = chunks.map((chunk) => `data: ${JSON.stringify(chunk)}`);
	events.push('data: [DONE]');
	return `${events.join('\n\n')}\n\n`;
}

function streamResponse(body) {
	return {
		method: 'POST',
		url: '/v1/chat/completions',
		status: 200,
		headers: { 'content-type': 'text/event-stream' },
		body,
	};
}

describe('completeWithContinuations', () => {
	it('replaces blocked stop responses instead of concatenating them', async () => {
		let stopCalls = 0;
		const server = await startFakeModelServer({
			responses: [
				streamResponse(
					sse([
						{
							choices: [
								{
									delta: { content: 'Blocked answer.' },
									finish_reason: 'stop',
								},
							],
						},
					]),
				),
				streamResponse(
					sse([
						{
							choices: [
								{
									delta: { content: 'Corrected answer.' },
									finish_reason: 'stop',
								},
							],
						},
					]),
				),
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
