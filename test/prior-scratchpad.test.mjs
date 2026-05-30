import assert from 'node:assert/strict';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { describe, it } from 'node:test';
import { main, parseArgs } from '../src/app.mjs';
import { startFakeModelServer } from '../test-support/fake-model-server.mjs';

function okProposal(scratchpad = '') {
	const content = JSON.stringify({
		status: 'OK',
		messages: [],
		files: [],
		patches: [],
		scratchpad,
	});
	return {
		choices: [
			{ finish_reason: 'stop', message: { content, role: 'assistant' } },
		],
		id: 'chatcmpl_test',
		object: 'chat.completion',
	};
}

async function runWith(argv, cwd) {
	return main(argv, {
		cwd,
		env: {},
		stdout: { write() {} },
		stderr: { write() {} },
	});
}

async function setup(scratchpad = '') {
	const server = await startFakeModelServer({
		responses: [
			{
				method: 'POST',
				url: '/v1/chat/completions',
				status: 200,
				body: okProposal(scratchpad),
			},
		],
	});
	const cwd = await mkdtemp(join(tmpdir(), 'kodr-scratch-'));
	await writeFile(join(cwd, 'prompt.md'), 'do a task');
	return { server, cwd };
}

function baseArgs(server, extra = []) {
	return [
		'run',
		'--base-url',
		server.baseUrl,
		'--model',
		'fake',
		'--prompt-file',
		'prompt.md',
		'--yes',
		...extra,
	];
}

describe('prior scratchpad injection', () => {
	it('does not inject when --prior-scratchpad is not set', async () => {
		const { server, cwd } = await setup();
		try {
			await runWith(baseArgs(server), cwd);
			const userMsg = server.recordings[0].requestBody.messages.find(
				(m) => m.role === 'user',
			);
			assert.ok(!userMsg.content.includes('Prior scratchpad'));
		} finally {
			await server.close();
		}
	});

	it('injects scratchpad content into the user message', async () => {
		const { server, cwd } = await setup();
		try {
			await writeFile(
				join(cwd, 'scratch.md'),
				'{"plan":["step1"],"done":[],"next":"step1"}',
			);

			await runWith(
				baseArgs(server, ['--prior-scratchpad', 'scratch.md']),
				cwd,
			);

			const userMsg = server.recordings[0].requestBody.messages.find(
				(m) => m.role === 'user',
			);
			assert.ok(userMsg.content.includes('## Prior scratchpad'));
			assert.ok(userMsg.content.includes('step1'));
		} finally {
			await server.close();
		}
	});

	it('skips injection when the scratchpad file is empty', async () => {
		const { server, cwd } = await setup();
		try {
			await writeFile(join(cwd, 'empty.md'), '   ');

			await runWith(baseArgs(server, ['--prior-scratchpad', 'empty.md']), cwd);

			const userMsg = server.recordings[0].requestBody.messages.find(
				(m) => m.role === 'user',
			);
			assert.ok(!userMsg.content.includes('Prior scratchpad'));
		} finally {
			await server.close();
		}
	});

	it('skips injection when the scratchpad file does not exist', async () => {
		const { server, cwd } = await setup();
		try {
			await runWith(
				baseArgs(server, ['--prior-scratchpad', 'nonexistent-scratch.md']),
				cwd,
			);

			const userMsg = server.recordings[0].requestBody.messages.find(
				(m) => m.role === 'user',
			);
			assert.ok(!userMsg.content.includes('Prior scratchpad'));
		} finally {
			await server.close();
		}
	});

	it('truncates long scratchpad content at 2000 characters', async () => {
		const { server, cwd } = await setup();
		try {
			await writeFile(join(cwd, 'long.md'), 'x'.repeat(3000));

			await runWith(baseArgs(server, ['--prior-scratchpad', 'long.md']), cwd);

			const userMsg = server.recordings[0].requestBody.messages.find(
				(m) => m.role === 'user',
			);
			assert.ok(userMsg.content.includes('(truncated)'));
			const scratchSection = userMsg.content.split('## Prior scratchpad')[1];
			assert.ok(scratchSection.length < 2200);
		} finally {
			await server.close();
		}
	});

	it('resolves "last" alias to most recent run scratchpad', async () => {
		const plan = '{"plan":["alpha","beta"],"done":[],"next":"alpha"}';
		const { server: s1, cwd } = await setup(plan);
		try {
			await runWith(baseArgs(s1), cwd);
		} finally {
			await s1.close();
		}

		const s2 = await startFakeModelServer({
			responses: [
				{
					method: 'POST',
					url: '/v1/chat/completions',
					status: 200,
					body: okProposal(),
				},
			],
		});
		try {
			await runWith(baseArgs(s2, ['--prior-scratchpad', 'last']), cwd);

			const userMsg = s2.recordings[0].requestBody.messages.find(
				(m) => m.role === 'user',
			);
			assert.ok(
				userMsg.content.includes('## Prior scratchpad'),
				'should inject prior scratchpad',
			);
			assert.ok(userMsg.content.includes('alpha'));
		} finally {
			await s2.close();
		}
	});
});

describe('parseArgs --prior-scratchpad', () => {
	it('stores path in priorScratchpadPath', () => {
		const opts = parseArgs(['run', '--prior-scratchpad', 'my-scratch.md'], {});
		assert.equal(opts.priorScratchpadPath, 'my-scratch.md');
	});

	it('accepts "last" as alias', () => {
		const opts = parseArgs(['run', '--prior-scratchpad', 'last'], {});
		assert.equal(opts.priorScratchpadPath, 'last');
	});
});
