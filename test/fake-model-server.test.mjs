import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { startFakeModelServer } from '../test-support/fake-model-server.mjs';

describe('startFakeModelServer', () => {
	it('serves default OpenAI-compatible model and chat responses', async () => {
		const server = await startFakeModelServer({
			modelId: 'queued-default-model',
		});

		try {
			const modelsResponse = await fetch(`${server.baseUrl}/models`);
			const models = await modelsResponse.json();

			assert.equal(modelsResponse.status, 200);
			assert.equal(models.data[0].id, 'queued-default-model');

			const chatResponse = await fetch(`${server.baseUrl}/chat/completions`, {
				body: JSON.stringify({
					messages: [
						{
							content: 'hello',
							role: 'user',
						},
					],
					model: 'queued-default-model',
				}),
				headers: {
					authorization: 'Bearer should-not-be-recorded',
					'content-type': 'application/json',
				},
				method: 'POST',
			});
			const chat = await chatResponse.json();

			assert.equal(chatResponse.status, 200);
			assert.equal(chat.choices[0].message.content, 'koder-probe-ok');
			assert.equal(
				server.recordings[1].requestHeaders.authorization,
				'[redacted]',
			);
			assert.equal(
				server.recordings[1].requestBody.model,
				'queued-default-model',
			);
			assert.equal(
				server.recordings[1].responseBody.choices[0].message.content,
				'koder-probe-ok',
			);
		} finally {
			await server.close();
		}
	});

	it('uses queued responses before falling back to defaults', async () => {
		const server = await startFakeModelServer({
			responses: [
				{
					body: {
						data: [
							{
								id: 'queued-model',
								object: 'model',
							},
						],
						object: 'list',
					},
					method: 'GET',
					status: 200,
					url: '/v1/models',
				},
			],
		});

		try {
			const queuedResponse = await fetch(`${server.baseUrl}/models`);
			const queued = await queuedResponse.json();
			const defaultResponse = await fetch(`${server.baseUrl}/models`);
			const fallback = await defaultResponse.json();

			assert.equal(queued.data[0].id, 'queued-model');
			assert.equal(fallback.data[0].id, 'fake-local-model');
			assert.equal(
				server.recordings[0].responseBody.data[0].id,
				'queued-model',
			);
			assert.equal(
				server.recordings[1].responseBody.data[0].id,
				'fake-local-model',
			);
		} finally {
			await server.close();
		}
	});
});
