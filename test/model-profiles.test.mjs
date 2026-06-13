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
		// S1: local measured default is 'none' (json_schema stalls both qwen3.6
		// and gemma-4; json_object HTTP 400 from LM Studio — phase 112 A/B).
		assert.equal(profile.structuredOutput, 'none');
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

	it('openrouter built-in profile has structuredOutput json_schema', () => {
		const profile = resolveModelProfile({
			model: 'anthropic/claude-3-opus',
			provider: 'openrouter',
		});

		// Falls through to the openrouter wildcard profile
		assert.equal(profile.structuredOutput, 'json_schema');
	});

	it('applyModelProfileDefaults threads structuredOutputMode into options', () => {
		const options = applyModelProfileDefaults({
			model: 'qwen/qwen3.6-35b-a3b',
			provider: 'local',
		});

		assert.equal(options.structuredOutputMode, 'none');
	});

	it('user override of structuredOutput is accepted for non-lmstudio profiles', async () => {
		const cwd = await mkdtemp(join(tmpdir(), 'kodr-model-profiles-so-'));
		await mkdir(join(cwd, '.kodr'), { recursive: true });
		await writeFile(
			join(cwd, '.kodr', 'model-profiles.json'),
			JSON.stringify({
				profiles: {
					'ollama/custom/model': {
						contextWindow: 4096,
						structuredOutput: 'json_schema',
					},
				},
			}),
			'utf8',
		);

		const profile = resolveModelProfile(
			{ model: 'custom/model', provider: 'ollama' },
			{},
			cwd,
		);
		assert.equal(profile.structuredOutput, 'json_schema');
	});

	it('rejects json_object for lmstudio profiles (LM Studio HTTP 400)', async () => {
		const cwd = await mkdtemp(join(tmpdir(), 'kodr-model-profiles-bad-'));
		await mkdir(join(cwd, '.kodr'), { recursive: true });
		await writeFile(
			join(cwd, '.kodr', 'model-profiles.json'),
			JSON.stringify({
				profiles: {
					'lmstudio/bad/model': {
						contextWindow: 4096,
						structuredOutput: 'json_object',
					},
				},
			}),
			'utf8',
		);

		// loadModelProfiles should throw loudly at config load time
		const { loadModelProfiles } = await import('../src/model-profiles.mjs');
		assert.throws(
			() => loadModelProfiles(cwd),
			/structuredOutput.*json_object.*LM Studio/u,
		);
	});

	it('unknown structuredOutput value falls back to provider default', async () => {
		const cwd = await mkdtemp(join(tmpdir(), 'kodr-model-profiles-unk-'));
		await mkdir(join(cwd, '.kodr'), { recursive: true });
		await writeFile(
			join(cwd, '.kodr', 'model-profiles.json'),
			JSON.stringify({
				profiles: {
					'ollama/custom/model': {
						contextWindow: 4096,
						structuredOutput: 'unsupported_value',
					},
				},
			}),
			'utf8',
		);

		const profile = resolveModelProfile(
			{ model: 'custom/model', provider: 'ollama' },
			{},
			cwd,
		);
		// ollama falls back to 'none'
		assert.equal(profile.structuredOutput, 'none');
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

	// T3 (phase 118): toolWrites field in profiles.
	it('T3: toolWrites defaults to "auto" when not set in profile', () => {
		const profile = resolveModelProfile(
			{ model: 'qwen/qwen3.6-35b-a3b', provider: 'local' },
			{},
		);
		assert.equal(profile.toolWrites, 'auto');
	});

	it('T3: toolWrites from config file is normalized to valid values', async () => {
		const cwd = await mkdtemp(join(tmpdir(), 'kodr-profiles-toolwrites-'));
		await mkdir(join(cwd, '.kodr'), { recursive: true });
		await writeFile(
			join(cwd, '.kodr/model-profiles.json'),
			JSON.stringify([
				{
					id: 'gemma/gemma-4-27b',
					provider: 'local',
					toolWrites: 'envelope',
				},
			]),
		);
		const profile = resolveModelProfile(
			{ model: 'gemma/gemma-4-27b', provider: 'local' },
			{},
			cwd,
		);
		assert.equal(profile.toolWrites, 'envelope');
	});

	it('T3: invalid toolWrites falls back to "auto"', () => {
		const profile = resolveModelProfile(
			{ model: 'somemodel', provider: 'local' },
			{},
		);
		// No profile file, falls back to default which normalizes to 'auto'.
		assert.equal(profile.toolWrites, 'auto');
	});

	it('T3: applyModelProfileDefaults sets toolWritesMode to "auto" by default', () => {
		const options = applyModelProfileDefaults(
			{
				model: 'qwen/qwen3.6-35b-a3b',
				provider: 'local',
				baseUrl: 'http://localhost:1234/v1',
			},
			{},
		);
		// No probe.json, so 'auto' stays 'auto'.
		assert.equal(options.toolWritesMode, 'auto');
	});

	it('T3: applyModelProfileDefaults resolves to "native" when probe.json says native', async () => {
		const cwd = await mkdtemp(join(tmpdir(), 'kodr-profiles-probe-resolve-'));
		const { saveProbeResult } = await import('../src/probe-persistence.mjs');
		await saveProbeResult(
			cwd,
			'http://localhost:1234/v1',
			'qwen/qwen3.6-35b-a3b',
			{ toolSupport: 'native' },
		);
		const options = applyModelProfileDefaults(
			{
				model: 'qwen/qwen3.6-35b-a3b',
				provider: 'local',
				baseUrl: 'http://localhost:1234/v1',
			},
			{},
			cwd,
		);
		assert.equal(options.toolWritesMode, 'native');
	});

	it('T3: toolWrites serialized in modelProfile', () => {
		const options = applyModelProfileDefaults(
			{
				model: 'qwen/qwen3.6-35b-a3b',
				provider: 'local',
				baseUrl: 'http://localhost:1234/v1',
			},
			{},
		);
		assert.equal(options.modelProfile.toolWrites, 'auto');
	});
});
