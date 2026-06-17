import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import {
	applyProjectConfig,
	GATE_KEYS,
	loadProjectConfig,
	ProjectConfigError,
	renderShowConfig,
} from '../src/project-config.mjs';
import { parseArgs, main, CliError } from '../src/app.mjs';

// Helper: create a temp dir with an optional .kodr/config.json
async function setup(configContent) {
	const cwd = await mkdtemp(join(tmpdir(), 'kodr-pc-'));
	if (configContent !== undefined) {
		await mkdir(join(cwd, '.kodr'), { recursive: true });
		await writeFile(
			join(cwd, '.kodr', 'config.json'),
			typeof configContent === 'string'
				? configContent
				: JSON.stringify(configContent, null, 2),
		);
	}
	return cwd;
}

// Helper: make a minimal io object for main()
function makeIo(cwd, env = {}) {
	let out = '';
	let err = '';
	return {
		cwd,
		env,
		stdout: {
			write: (s) => {
				out += s;
			},
		},
		stderr: {
			write: (s) => {
				err += s;
			},
		},
		getOut: () => out,
		getErr: () => err,
	};
}

// ---------------------------------------------------------------------------
// loadProjectConfig
// ---------------------------------------------------------------------------

describe('loadProjectConfig', () => {
	it('returns null when no config file exists', async () => {
		const cwd = await setup();
		assert.equal(loadProjectConfig(cwd), null);
	});

	it('loads valid config and skips "//" comment keys', async () => {
		const cwd = await setup({
			'//': 'ignored',
			model: 'custom/model',
			tools: true,
			stream: false,
		});
		const result = loadProjectConfig(cwd);
		assert.ok(result);
		assert.equal(result.config.model, 'custom/model');
		assert.equal(result.config.tools, true);
		assert.equal(result.config['//'], undefined);
	});

	it('trims trailing slashes from baseUrl', async () => {
		const cwd = await setup({ baseUrl: 'http://example.com/v1/' });
		const result = loadProjectConfig(cwd);
		assert.equal(result.config.baseUrl, 'http://example.com/v1');
	});

	it('throws for gate keys', async () => {
		for (const key of GATE_KEYS) {
			const cwd = await setup({ [key]: true });
			assert.throws(
				() => loadProjectConfig(cwd),
				(e) =>
					e instanceof ProjectConfigError &&
					e.message.includes(`"${key}"`) &&
					e.message.includes('gate key'),
				`expected gate key rejection for "${key}"`,
			);
		}
	});

	it('throws on invalid type for known keys', async () => {
		const cases = [
			{ model: 42 },
			{ baseUrl: true },
			{ tools: 'yes' },
			{ stream: 1 },
			{ heal: 'true' },
			{ timeoutMs: 'fast' },
			{ maxTurns: 0 },
			{ maxRetries: -1 },
			{ maxTokens: 1.5 },
			{ maxCostUsd: 'cheap' },
			{ protectExisting: 0 },
		];
		for (const badConfig of cases) {
			const key = Object.keys(badConfig)[0];
			const cwd = await setup(badConfig);
			assert.throws(
				() => loadProjectConfig(cwd),
				(e) =>
					e instanceof ProjectConfigError && e.message.includes(`"${key}"`),
				`expected type error for key "${key}"`,
			);
		}
	});

	it('warns on unknown keys and ignores them', async () => {
		const cwd = await setup({ unknownKey: 'value', model: 'valid/model' });
		const stderrMessages = [];
		const origWrite = process.stderr.write.bind(process.stderr);
		process.stderr.write = (s) => {
			stderrMessages.push(s);
			return true;
		};
		try {
			const result = loadProjectConfig(cwd);
			assert.equal(result.config.model, 'valid/model');
			assert.equal(result.config.unknownKey, undefined);
			assert.ok(stderrMessages.some((m) => m.includes('unknownKey')));
		} finally {
			process.stderr.write = origWrite;
		}
	});

	it('throws on invalid JSON', async () => {
		const cwd = await setup('{ not valid json }');
		assert.throws(
			() => loadProjectConfig(cwd),
			(e) => e instanceof ProjectConfigError,
		);
	});

	it('throws when config is not a JSON object', async () => {
		const cwd = await setup('[1, 2, 3]');
		assert.throws(
			() => loadProjectConfig(cwd),
			(e) =>
				e instanceof ProjectConfigError &&
				e.message.includes('must be a JSON object'),
		);
	});

	it('uses KODR_CONFIG env var to locate config', async () => {
		const cwd = await setup();
		const configPath = join(cwd, 'custom.json');
		await writeFile(configPath, JSON.stringify({ tools: true }));
		const result = loadProjectConfig(cwd, { KODR_CONFIG: configPath });
		assert.equal(result.config.tools, true);
	});
});

// ---------------------------------------------------------------------------
// applyProjectConfig
// ---------------------------------------------------------------------------

describe('applyProjectConfig', () => {
	it('applies config values when sentinels are false', () => {
		const options = {
			model: 'default/model',
			tools: false,
			stream: false,
			testCommand: '',
			timeoutMs: 600000,
			maxTurns: 8,
			_modelSet: false,
			_modelEnvSet: false,
			_toolsSet: false,
			_streamSet: false,
			_testCommandSet: false,
			_timeoutSet: false,
			_maxTurnsSet: false,
		};
		const loadedConfig = {
			config: { model: 'config/model', tools: true, testCommand: 'npm test' },
			configPath: '/fake/path',
		};
		const applied = applyProjectConfig(options, loadedConfig);
		assert.deepEqual(applied.sort(), ['model', 'testCommand', 'tools']);
		assert.equal(options.model, 'config/model');
		assert.equal(options.tools, true);
		assert.equal(options.testCommand, 'npm test');
	});

	it('does not apply when CLI sentinel is true', () => {
		const options = {
			model: 'cli/model',
			_modelSet: true,
			_modelEnvSet: false,
		};
		const loadedConfig = {
			config: { model: 'config/model' },
			configPath: '/fake',
		};
		const applied = applyProjectConfig(options, loadedConfig);
		assert.equal(applied.length, 0);
		assert.equal(options.model, 'cli/model');
	});

	it('does not apply when env sentinel is true', () => {
		const options = {
			model: 'env/model',
			_modelSet: false,
			_modelEnvSet: true,
		};
		const loadedConfig = {
			config: { model: 'config/model' },
			configPath: '/fake',
		};
		const applied = applyProjectConfig(options, loadedConfig);
		assert.equal(applied.length, 0);
		assert.equal(options.model, 'env/model');
	});

	it('returns empty array when loadedConfig is null', () => {
		const options = {};
		const applied = applyProjectConfig(options, null);
		assert.deepEqual(applied, []);
	});
});

// ---------------------------------------------------------------------------
// parseArgs precedence matrix
// ---------------------------------------------------------------------------

describe('parseArgs precedence', () => {
	it('no-config regression: parseArgs with no config resolves auto defaults', async () => {
		const cwd = await setup(); // no config file
		const opts = parseArgs(['run', '-p', 'hi'], {}, cwd);
		assert.equal(opts.model, 'qwen/qwen3.6-35b-a3b');
		assert.equal(opts.baseUrl, 'http://localhost:1234/v1');
		assert.equal(opts.timeoutMs, 600000);
		// tools resolves from profile nativeToolCalls (true for default profile)
		assert.equal(opts.tools, true);
		// stream and heal stay 'auto' until resolved in main()
		assert.equal(opts.stream, 'auto');
		assert.equal(opts.heal, 'auto');
		assert.equal(opts.inspectContext, 'auto');
		assert.equal(opts.testCommand, '');
		assert.equal(opts.maxTurns, 8);
		assert.equal(opts.maxRetries, 7);
	});

	it('flag beats config for model', async () => {
		const cwd = await setup({ model: 'config/model' });
		const opts = parseArgs(
			['run', '-p', 'hi', '--model', 'flag/model'],
			{},
			cwd,
		);
		assert.equal(opts.model, 'flag/model');
		assert.equal(opts.configSources.model, 'flag');
	});

	it('env beats config for model', async () => {
		const cwd = await setup({ model: 'config/model' });
		const opts = parseArgs(['run', '-p', 'hi'], { MODEL_ID: 'env/model' }, cwd);
		assert.equal(opts.model, 'env/model');
		assert.equal(opts.configSources.model, 'env');
	});

	it('config beats builtin for model', async () => {
		const cwd = await setup({ model: 'config/model' });
		const opts = parseArgs(['run', '-p', 'hi'], {}, cwd);
		assert.equal(opts.model, 'config/model');
		assert.equal(opts.configSources.model, 'config');
	});

	it('flag beats config for timeoutMs', async () => {
		const cwd = await setup({ timeoutMs: 30000 });
		const opts = parseArgs(
			['run', '-p', 'hi', '--timeout-ms', '5000'],
			{},
			cwd,
		);
		assert.equal(opts.timeoutMs, 5000);
		assert.equal(opts.configSources.timeoutMs, 'flag');
	});

	it('config beats profile for timeoutMs', async () => {
		const cwd = await setup({ timeoutMs: 12345 });
		const opts = parseArgs(['run', '-p', 'hi'], {}, cwd);
		assert.equal(opts.timeoutMs, 12345);
		assert.equal(opts.configSources.timeoutMs, 'config');
	});

	it('profile beats builtin for timeoutMs when config absent', async () => {
		const cwd = await setup(); // no config
		const opts = parseArgs(['run', '-p', 'hi'], {}, cwd);
		// The builtin default matches the profile; source is 'profile'
		assert.equal(opts.configSources.timeoutMs, 'profile');
	});

	it('flag beats config for testCommand', async () => {
		const cwd = await setup({ testCommand: 'npm test' });
		const opts = parseArgs(
			['run', '-p', 'hi', '--test', 'node --test'],
			{},
			cwd,
		);
		assert.equal(opts.testCommand, 'node --test');
		assert.equal(opts.configSources.testCommand, 'flag');
	});

	it('config sets tools when flag not passed', async () => {
		const cwd = await setup({ tools: true });
		const opts = parseArgs(['run', '-p', 'hi'], {}, cwd);
		assert.equal(opts.tools, true);
		assert.equal(opts.configSources.tools, 'config');
	});

	it('flag beats config for tools', async () => {
		// There is no --no-tools flag; --tools always forces true
		const cwd = await setup({ tools: false });
		const opts = parseArgs(['run', '-p', 'hi', '--tools'], {}, cwd);
		assert.equal(opts.tools, true);
		assert.equal(opts.configSources.tools, 'flag');
	});

	it('config sets stream and heal', async () => {
		const cwd = await setup({ stream: true, heal: true });
		const opts = parseArgs(['run', '-p', 'hi'], {}, cwd);
		assert.equal(opts.stream, true);
		assert.equal(opts.heal, true);
		assert.equal(opts.configSources.stream, 'config');
		assert.equal(opts.configSources.heal, 'config');
	});

	it('config sets maxTurns and maxRetries', async () => {
		const cwd = await setup({ maxTurns: 4, maxRetries: 3 });
		const opts = parseArgs(['run', '-p', 'hi'], {}, cwd);
		assert.equal(opts.maxTurns, 4);
		assert.equal(opts.maxRetries, 3);
		assert.equal(opts.configSources.maxTurns, 'config');
		assert.equal(opts.configSources.maxRetries, 'config');
	});

	it('flag beats config for maxTurns', async () => {
		const cwd = await setup({ maxTurns: 4 });
		const opts = parseArgs(['run', '-p', 'hi', '--max-turns', '2'], {}, cwd);
		assert.equal(opts.maxTurns, 2);
		assert.equal(opts.configSources.maxTurns, 'flag');
	});

	it('config sets protectExisting', async () => {
		const cwd = await setup({ protectExisting: true });
		const opts = parseArgs(['run', '-p', 'hi'], {}, cwd);
		assert.equal(opts.protectExisting, true);
		assert.equal(opts.configSources.protectExisting, 'config');
	});

	it('config sets routeAuto (phase 141)', async () => {
		const cwd = await setup({ routeAuto: true });
		const opts = parseArgs(['run', '-p', 'hi'], {}, cwd);
		assert.equal(opts.routeAuto, true);
	});

	it('configSources uses profile for tools auto-resolved from profile', async () => {
		const cwd = await setup({ model: 'config/model' });
		const opts = parseArgs(['run', '-p', 'hi'], {}, cwd);
		assert.equal(opts.configSources.tools, 'profile');
		assert.equal(opts.configSources.stream, 'builtin');
		assert.equal(opts.configSources.heal, 'builtin');
		assert.equal(opts.configSources.inspectContext, 'builtin');
	});
});

// ---------------------------------------------------------------------------
// Gate refusal
// ---------------------------------------------------------------------------

describe('gate key rejection', () => {
	for (const key of GATE_KEYS) {
		it(`rejects gate key "${key}" loudly`, async () => {
			const cwd = await setup({ [key]: true });
			assert.throws(
				() => parseArgs(['run', '-p', 'hi'], {}, cwd),
				(e) => e instanceof CliError && e.message.includes(`"${key}"`),
				`expected loud rejection for "${key}"`,
			);
		});
	}

	it('config testCommand is validated at use time, not load time', async () => {
		// Loading succeeds even with an allowlist-invalid command
		const cwd = await setup({ testCommand: 'rm -rf /' });
		// parseArgs should succeed; the testCommand passes through
		const opts = parseArgs(['run', '-p', 'hi'], {}, cwd);
		assert.equal(opts.testCommand, 'rm -rf /');
		// Validation happens in verification-runner.mjs when the test is run
	});
});

// ---------------------------------------------------------------------------
// kodr init command
// ---------------------------------------------------------------------------

describe('kodr init', () => {
	it('writes starter config with model and baseUrl', async () => {
		const cwd = await setup();
		const io = makeIo(cwd);
		const result = await main(['init'], io);
		assert.equal(result.ok, true);
		assert.equal(result.command, 'init');

		const written = JSON.parse(
			await readFile(join(cwd, '.kodr', 'config.json'), 'utf8'),
		);
		assert.ok(written['//'], 'starter should have comment key');
		assert.ok(written.model, 'starter should have model');
		assert.ok(written.baseUrl, 'starter should have baseUrl');
	});

	it('detects npm test from package.json scripts.test', async () => {
		const cwd = await setup();
		await writeFile(
			join(cwd, 'package.json'),
			JSON.stringify({ scripts: { test: 'node --test test/*.mjs' } }),
		);
		const io = makeIo(cwd);
		await main(['init'], io);

		const written = JSON.parse(
			await readFile(join(cwd, '.kodr', 'config.json'), 'utf8'),
		);
		assert.equal(written.testCommand, 'npm test');
	});

	it('omits testCommand when package.json has no test script', async () => {
		const cwd = await setup();
		await writeFile(join(cwd, 'package.json'), JSON.stringify({ name: 'foo' }));
		const io = makeIo(cwd);
		await main(['init'], io);

		const written = JSON.parse(
			await readFile(join(cwd, '.kodr', 'config.json'), 'utf8'),
		);
		assert.equal(written.testCommand, undefined);
	});

	it('omits testCommand when no package.json exists', async () => {
		const cwd = await setup();
		const io = makeIo(cwd);
		await main(['init'], io);

		const written = JSON.parse(
			await readFile(join(cwd, '.kodr', 'config.json'), 'utf8'),
		);
		assert.equal(written.testCommand, undefined);
	});

	it('refuses to overwrite existing config without --force', async () => {
		const cwd = await setup({ model: 'original' });
		const io = makeIo(cwd);
		await assert.rejects(
			() => main(['init'], io),
			(e) => e instanceof CliError && e.message.includes('--force'),
		);
	});

	it('overwrites existing config with --force', async () => {
		const cwd = await setup({ model: 'original' });
		const io = makeIo(cwd);
		await main(['init', '--force'], io);

		const written = JSON.parse(
			await readFile(join(cwd, '.kodr', 'config.json'), 'utf8'),
		);
		assert.ok(written.model !== 'original' || written['//']);
	});

	it('written starter parses with JSON.parse and round-trips through loader', async () => {
		const cwd = await setup();
		const io = makeIo(cwd);
		await main(['init'], io);

		// Round-trip: loadProjectConfig must accept what init wrote
		const result = loadProjectConfig(cwd);
		assert.ok(result);
		assert.ok(result.config.model);
		assert.ok(result.config.baseUrl);
	});
});

// ---------------------------------------------------------------------------
// --show-config
// ---------------------------------------------------------------------------

describe('--show-config', () => {
	it('prints resolved values with sources and exits', async () => {
		const cwd = await setup({ tools: true, testCommand: 'npm test' });
		const io = makeIo(cwd);
		const result = await main(['run', '--show-config'], io);
		assert.equal(result.ok, true);
		assert.ok(io.getOut().includes('tools'));
		assert.ok(io.getOut().includes('config'));
		assert.ok(io.getOut().includes('testCommand'));
	});

	it('renderShowConfig includes all config keys with sources', async () => {
		const cwd = await setup({ model: 'config/model' });
		const opts = parseArgs(['run', '-p', 'hi', '--stream'], {}, cwd);
		const output = renderShowConfig(opts);
		assert.ok(output.includes('model'));
		assert.ok(output.includes('config/model'));
		assert.ok(output.includes('config')); // model source
		assert.ok(output.includes('stream'));
		assert.ok(output.includes('flag')); // stream source
		assert.ok(output.includes('tools'));
		assert.ok(output.includes('builtin')); // tools source
	});
});

// ---------------------------------------------------------------------------
// Channel inheritance
// ---------------------------------------------------------------------------

describe('channel inheritance', () => {
	it('serve command inherits config defaults through parseArgs', async () => {
		const cwd = await setup({ tools: true, stream: true });
		const opts = parseArgs(['serve'], {}, cwd);
		assert.equal(opts.tools, true);
		assert.equal(opts.stream, true);
		assert.equal(opts.configSources.tools, 'config');
	});

	it('tui command inherits config defaults through parseArgs', async () => {
		const cwd = await setup({ heal: true, maxTurns: 5 });
		const opts = parseArgs(['tui'], {}, cwd);
		assert.equal(opts.heal, true);
		assert.equal(opts.maxTurns, 5);
	});
});

// ── Phase 116: skillsDirs and agentsDirs config keys ────────────────────────

describe('skillsDirs and agentsDirs config keys', () => {
	it('accepts valid skillsDirs array in config', async () => {
		const cwd = await setup({ skillsDirs: ['/a', '/b'] });
		const loaded = loadProjectConfig(cwd, {});
		assert.deepEqual(loaded.config.skillsDirs, ['/a', '/b']);
	});

	it('accepts valid agentsDirs array in config', async () => {
		const cwd = await setup({ agentsDirs: ['/x'] });
		const loaded = loadProjectConfig(cwd, {});
		assert.deepEqual(loaded.config.agentsDirs, ['/x']);
	});

	it('rejects non-array skillsDirs', async () => {
		const cwd = await setup({ skillsDirs: '/bad-not-array' });
		assert.throws(
			() => loadProjectConfig(cwd, {}),
			(err) => {
				assert.ok(err instanceof ProjectConfigError);
				assert.match(err.message, /skillsDirs/u);
				return true;
			},
		);
	});

	it('rejects array with non-string entries', async () => {
		const cwd = await setup({ skillsDirs: ['/ok', 42] });
		assert.throws(
			() => loadProjectConfig(cwd, {}),
			(err) => {
				assert.ok(err instanceof ProjectConfigError);
				return true;
			},
		);
	});

	it('parseArgs merges config skillsDirs after CLI flags (CLI first)', async () => {
		const cwd = await setup({ skillsDirs: ['/from-config'] });
		const opts = parseArgs(['--skills-dir', '/from-cli'], {}, cwd);
		// CLI value comes first (higher precedence), then config value
		assert.deepEqual(opts.skillsDirs, ['/from-cli', '/from-config']);
	});

	it('config skillsDirs applied when no CLI flags', async () => {
		const cwd = await setup({ skillsDirs: ['/config-only'] });
		const opts = parseArgs([], {}, cwd);
		assert.deepEqual(opts.skillsDirs, ['/config-only']);
	});
});

describe('hooks config key (Phase 191)', () => {
	it('accepts a valid hooks block with preCommit and prePush', async () => {
		const cwd = await setup({
			hooks: {
				preCommit: 'kodr check --changed --strict',
				prePush: 'kodr check --strict --deep',
			},
		});
		const loaded = loadProjectConfig(cwd, {});
		assert.deepEqual(loaded.config.hooks, {
			preCommit: 'kodr check --changed --strict',
			prePush: 'kodr check --strict --deep',
		});
	});

	it('accepts hooks with only preCommit set', async () => {
		const cwd = await setup({
			hooks: { preCommit: 'kodr check --changed --strict --deep' },
		});
		const loaded = loadProjectConfig(cwd, {});
		assert.equal(
			loaded.config.hooks.preCommit,
			'kodr check --changed --strict --deep',
		);
		assert.equal(loaded.config.hooks.prePush, undefined);
	});

	it('rejects hooks that is not an object', async () => {
		const cwd = await setup({ hooks: 'kodr check' });
		assert.throws(
			() => loadProjectConfig(cwd, {}),
			(err) => {
				assert.ok(err instanceof ProjectConfigError);
				assert.match(err.message, /hooks/u);
				return true;
			},
		);
	});

	it('rejects hooks with unknown key', async () => {
		const cwd = await setup({ hooks: { preTest: 'kodr check' } });
		assert.throws(
			() => loadProjectConfig(cwd, {}),
			(err) => {
				assert.ok(err instanceof ProjectConfigError);
				assert.match(err.message, /unknown hook key/u);
				return true;
			},
		);
	});

	it('rejects hooks with non-string command value', async () => {
		const cwd = await setup({ hooks: { preCommit: 42 } });
		assert.throws(
			() => loadProjectConfig(cwd, {}),
			(err) => {
				assert.ok(err instanceof ProjectConfigError);
				return true;
			},
		);
	});

	it('rejects hooks with empty command string', async () => {
		const cwd = await setup({ hooks: { preCommit: '  ' } });
		assert.throws(
			() => loadProjectConfig(cwd, {}),
			(err) => {
				assert.ok(err instanceof ProjectConfigError);
				return true;
			},
		);
	});
});

describe('sensors config key (Phase 193)', () => {
	it('accepts a valid sensors block disabling a known sensor', async () => {
		const cwd = await setup({ sensors: { 'secret-in-response': false } });
		const loaded = loadProjectConfig(cwd, {});
		assert.deepEqual(loaded.config.sensors, { 'secret-in-response': false });
	});

	it('accepts mixed enabled/disabled sensors', async () => {
		const cwd = await setup({
			sensors: { 'secrets-at-rest': false, 'import-cycles': true },
		});
		const loaded = loadProjectConfig(cwd, {});
		assert.equal(loaded.config.sensors['secrets-at-rest'], false);
		assert.equal(loaded.config.sensors['import-cycles'], true);
	});

	it('rejects sensors that is not an object', async () => {
		const cwd = await setup({ sensors: ['secret-in-response'] });
		assert.throws(
			() => loadProjectConfig(cwd, {}),
			(err) => {
				assert.ok(err instanceof ProjectConfigError);
				return true;
			},
		);
	});

	it('rejects unknown sensor name', async () => {
		const cwd = await setup({ sensors: { 'made-up-sensor': false } });
		assert.throws(
			() => loadProjectConfig(cwd, {}),
			(err) => {
				assert.ok(err instanceof ProjectConfigError);
				assert.match(err.message, /unknown sensor/u);
				return true;
			},
		);
	});

	it('rejects non-boolean sensor value', async () => {
		const cwd = await setup({ sensors: { 'import-cycles': 'off' } });
		assert.throws(
			() => loadProjectConfig(cwd, {}),
			(err) => {
				assert.ok(err instanceof ProjectConfigError);
				return true;
			},
		);
	});

	it('sensors config maps to options.sensorToggles via parseArgs', async () => {
		const cwd = await setup({ sensors: { 'secret-in-response': false } });
		const opts = parseArgs([], {}, cwd);
		assert.deepEqual(opts.sensorToggles, { 'secret-in-response': false });
	});
});
