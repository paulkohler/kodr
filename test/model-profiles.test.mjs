import assert from 'node:assert/strict';
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import {
	applyModelProfileDefaults,
	resolveModelProfile,
	sessionContextCharsForProfile,
} from '../src/model-profiles.mjs';

describe('model profiles', () => {
	it('resolves built-in local model defaults', () => {
		const profile = resolveModelProfile({
			model: 'qwen/qwen3.6-35b-a3b',
			provider: 'local',
		});

		assert.equal(profile.matched, true);
		assert.equal(profile.contextWindow, 32768);
		assert.equal(profile.completionReserve, 4096);
		assert.equal(profile.timeoutMs, 600000);
		assert.equal(profile.nativeToolCalls, true);
		assert.equal(sessionContextCharsForProfile(profile), 114688);
	});

	it('uses a conservative fallback for unknown models', () => {
		const profile = resolveModelProfile({
			baseUrl: 'http://custom/v1',
			model: 'unknown/model',
			provider: 'local',
		});

		assert.equal(profile.matched, false);
		assert.equal(profile.source, 'fallback');
		assert.equal(profile.contextWindow, 32768);
		assert.equal(profile.baseUrl, 'http://custom/v1');
	});

	it('loads project or env configured profile overrides', async () => {
		const cwd = await mkdtemp(join(tmpdir(), 'kodr-model-profiles-'));
		await mkdir(join(cwd, '.kodr'), { recursive: true });
		await writeFile(
			join(cwd, '.kodr', 'model-profiles.json'),
			JSON.stringify({
				profiles: {
					'lmstudio/custom/model': {
						completionReserve: 1000,
						contextWindow: 4000,
						nativeToolCalls: false,
						responseEnvelope: 'text',
						timeoutMs: 1234,
					},
				},
			}),
			'utf8',
		);

		const options = applyModelProfileDefaults(
			{
				model: 'custom/model',
				provider: 'lmstudio',
				sessionContextChars: 48000,
				timeoutMs: 600000,
			},
			{},
			cwd,
		);

		assert.equal(options.timeoutMs, 1234);
		assert.equal(options.sessionContextChars, 12000);
		assert.equal(options.contextBudgetChars, 12000);
		assert.equal(options.nativeToolCalls, false);
		assert.equal(options.responseEnvelopeMode, 'text');
		assert.equal(
			options.modelProfile.source,
			join(cwd, '.kodr/model-profiles.json'),
		);
	});

	it('preserves explicit timeout and session compaction overrides', async () => {
		const cwd = await mkdtemp(join(tmpdir(), 'kodr-model-profiles-explicit-'));
		const options = applyModelProfileDefaults(
			{
				_sessionContextSet: true,
				_timeoutSet: true,
				model: 'qwen/qwen3.6-35b-a3b',
				provider: 'local',
				sessionContextChars: 12000,
				timeoutMs: 1000,
			},
			{},
			cwd,
		);

		assert.equal(options.timeoutMs, 1000);
		assert.equal(options.sessionContextChars, 12000);
		assert.equal(options.modelProfile.timeoutMs, 600000);
	});
});
