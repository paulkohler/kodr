import { readFileSync } from 'node:fs';
import { isAbsolute, resolve } from 'node:path';
import { EDIT_FORMATS, normalizeEditFormat } from './edit-formats.mjs';

export class ProjectConfigError extends Error {
	constructor(message) {
		super(message);
		this.name = 'ProjectConfigError';
	}
}

// Keys that may never appear in project config. Rejected loudly by name.
export const GATE_KEYS = [
	'yes',
	'gitCommit',
	'installDependencies',
	'enableHooks',
	'apiKey',
];

const KNOWN_KEYS = new Set([
	'//',
	'model',
	'baseUrl',
	'editFormat',
	'testCommand',
	'testCwd',
	'tools',
	'stream',
	'heal',
	'inspectContext',
	'lsp',
	'timeoutMs',
	'maxTurns',
	'maxRetries',
	'maxTokens',
	'maxCostUsd',
	'protectExisting',
	'skillsDirs',
	'agentsDirs',
]);

// Known LSP server names from the default registry. Config may reference only
// these names; command strings are rejected to prevent config-injection attacks.
export const KNOWN_LSP_SERVERS = new Set([
	'gopls',
	'pyright',
	'rust-analyzer',
	'typescript-language-server',
]);

// Returns the path where a project config should live, regardless of whether
// the file exists. Used by `kodr init` to decide where to write.
export function defaultConfigPath(cwd, env = {}) {
	const configured = env.KODR_CONFIG || '';
	if (configured) {
		return isAbsolute(configured) ? configured : resolve(cwd, configured);
	}
	return resolve(cwd, '.kodr/config.json');
}

// Returns the path to an existing project config file, or '' if none is found.
function resolveConfigPath(cwd, env) {
	const configured = env.KODR_CONFIG || '';
	if (configured) {
		const p = isAbsolute(configured) ? configured : resolve(cwd, configured);
		// Env-configured path must exist; don't silently fall back.
		return p;
	}
	try {
		const p = resolve(cwd, '.kodr/config.json');
		readFileSync(p, 'utf8');
		return p;
	} catch {
		return '';
	}
}

// Load, parse, and validate a project config. Returns { config, configPath }
// or null when no config file is present. Throws ProjectConfigError for any
// structural or type violation.
export function loadProjectConfig(cwd = process.cwd(), env = {}) {
	const configPath = resolveConfigPath(cwd, env);
	if (!configPath) return null;

	let raw;
	try {
		raw = readFileSync(configPath, 'utf8');
	} catch (error) {
		if (env.KODR_CONFIG) {
			throw new ProjectConfigError(
				`cannot read ${configPath}: ${error.message}`,
			);
		}
		return null;
	}

	let parsed;
	try {
		parsed = JSON.parse(raw);
	} catch (error) {
		throw new ProjectConfigError(`${configPath}: ${error.message}`);
	}

	if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
		throw new ProjectConfigError(`${configPath}: config must be a JSON object`);
	}

	const config = {};
	for (const [key, value] of Object.entries(parsed)) {
		if (key === '//') continue;

		if (GATE_KEYS.includes(key)) {
			throw new ProjectConfigError(
				`${configPath}: "${key}" is a gate key and cannot be set in project config`,
			);
		}

		if (!KNOWN_KEYS.has(key)) {
			process.stderr.write(
				`warning: ${configPath}: unknown config key "${key}" ignored\n`,
			);
			continue;
		}

		config[key] = validateValue(key, value, configPath);
	}

	return { config, configPath };
}

function validateValue(key, value, configPath) {
	const fail = (msg) => {
		throw new ProjectConfigError(`${configPath}: "${key}" ${msg}`);
	};

	switch (key) {
		case 'model':
		case 'testCommand':
		case 'testCwd':
			if (typeof value !== 'string') fail('must be a string');
			return value;

		case 'editFormat':
			if (!EDIT_FORMATS.includes(value))
				fail(`must be one of: ${EDIT_FORMATS.join(', ')}`);
			return value;

		case 'baseUrl':
			if (typeof value !== 'string') fail('must be a string');
			return value.replace(/\/+$/u, '');

		case 'tools':
		case 'stream':
		case 'heal':
		case 'inspectContext':
		case 'protectExisting':
			if (typeof value !== 'boolean') fail('must be a boolean');
			return value;

		case 'lsp': {
			// Accepts true/false/'auto' (all/no/available servers) or an array of known server names.
			// Rejects command strings and unknown names to prevent config injection.
			if (value === true) return true;
			if (value === false) return false;
			if (value === 'auto') return 'auto';
			if (Array.isArray(value)) {
				for (const name of value) {
					if (typeof name !== 'string') {
						fail('server names must be strings');
					}
					if (!KNOWN_LSP_SERVERS.has(name)) {
						fail(`unknown LSP server name "${name}"`);
					}
				}
				return value;
			}
			fail('must be true, false, "auto", or an array of known server names');
			break;
		}

		case 'timeoutMs':
			if (!Number.isInteger(value) || value < 100)
				fail('must be an integer >= 100');
			return value;

		case 'maxTurns':
			if (!Number.isInteger(value) || value < 1)
				fail('must be an integer >= 1');
			return value;

		case 'maxRetries':
			if (!Number.isInteger(value) || value < 0)
				fail('must be a non-negative integer');
			return value;

		case 'maxTokens':
			if (!Number.isInteger(value) || value < 0)
				fail('must be a non-negative integer');
			return value;

		case 'maxCostUsd':
			if (typeof value !== 'number' || !Number.isFinite(value) || value < 0)
				fail('must be a non-negative number');
			return value;

		case 'skillsDirs':
		case 'agentsDirs': {
			if (!Array.isArray(value)) fail('must be an array of strings');
			for (const entry of value) {
				if (typeof entry !== 'string') {
					fail(`entries must be strings; got ${typeof entry}`);
				}
			}
			return value;
		}

		default:
			return value;
	}
}

// Sentinel fields that a subsequent resolution step (model profile,
// resolveModelOptions) reads to decide whether to override a value. When
// project config supplies a value, we mark the corresponding sentinel so the
// resolution step treats it as "already decided".
const CONFIG_SENTINELS = {
	timeoutMs: '_timeoutSet',
};

// Apply config values to options for fields that were not already set by a CLI
// flag or an environment variable. Returns an array of key names that were
// applied. The options object is mutated in place.
//
// The caller is responsible for setting _XSet sentinel fields on options before
// calling this function. Those sentinels are the contract: true means "CLI set
// this, do not touch it".
export function applyProjectConfig(options, loadedConfig) {
	if (!loadedConfig) return [];
	const { config } = loadedConfig;
	const applied = [];

	for (const [key, value] of Object.entries(config)) {
		if (shouldApply(key, options)) {
			// K3: array dir keys merge — CLI values come first (higher precedence),
			// then config values, all prepended to the default tiers.
			if (
				(key === 'skillsDirs' || key === 'agentsDirs') &&
				Array.isArray(options[key]) &&
				options[key].length > 0
			) {
				// CLI already has values; append config values after them (CLI wins).
				options[key] = [...options[key], ...value];
			} else {
				options[key] = value;
			}
			// Raise the corresponding sentinel so downstream resolution steps
			// (applyModelProfileDefaults) honour this config-supplied value.
			const sentinel = CONFIG_SENTINELS[key];
			if (sentinel) options[sentinel] = true;
			applied.push(key);
		}
	}

	return applied;
}

function shouldApply(key, options) {
	switch (key) {
		case 'model':
			return !options._modelSet && !options._modelEnvSet;
		case 'baseUrl':
			return !options._baseUrlSet && !options._baseUrlEnvSet;
		case 'editFormat':
			return !options._editFormatSet;
		case 'timeoutMs':
			return !options._timeoutSet;
		case 'maxTurns':
			return !options._maxTurnsSet;
		case 'maxRetries':
			return !options._maxRetriesSet;
		case 'tools':
			return !options._toolsSet;
		case 'stream':
			return !options._streamSet;
		case 'heal':
			return !options._healSet;
		case 'inspectContext':
			return !options._inspectContextSet;
		case 'lsp':
			return !options._lspSet;
		case 'testCommand':
			return !options._testCommandSet;
		case 'testCwd':
			return !options._testCwdSet;
		case 'maxTokens':
			return !options._maxTokensSet;
		case 'maxCostUsd':
			return !options._maxCostUsdSet;
		case 'protectExisting':
			return !options._protectExistingSet;
		// K3: skillsDirs and agentsDirs always merge (prepend config to defaults).
		// We use a special key here to prevent shouldApply from blocking the config
		// value — merging is handled at the call site.
		case 'skillsDirs':
		case 'agentsDirs':
			return true;
		default:
			return false;
	}
}

// Render the resolved config and sources table for --show-config.
export function renderShowConfig(options) {
	const sources = options.configSources || {};
	const COL1 = 20;
	const COL2 = 34;

	const rows = [
		['model', String(options.model ?? '')],
		['baseUrl', String(options.baseUrl ?? '')],
		['editFormat', String(options.editFormat ?? 'patch')],
		['tools', String(options.tools ?? 'auto')],
		['stream', String(options.stream ?? 'auto')],
		['heal', String(options.heal ?? 'auto')],
		['inspectContext', String(options.inspectContext ?? 'auto')],
		['lsp', lspConfigDisplay(options.lsp)],
		['testCommand', String(options.testCommand ?? '')],
		['testCwd', String(options.testCwd ?? '')],
		['timeoutMs', String(options.timeoutMs ?? '')],
		['maxTurns', String(options.maxTurns ?? '')],
		['maxRetries', String(options.maxRetries ?? '')],
		['maxTokens', String(options.maxTokens ?? '')],
		['maxCostUsd', String(options.maxCostUsd ?? '')],
		['protectExisting', String(options.protectExisting ?? false)],
	];

	return (
		rows
			.map(([key, val]) => {
				const source = sources[key] ?? 'builtin';
				return `${key.padEnd(COL1)}${val.padEnd(COL2)}${source}`;
			})
			.join('\n') + '\n'
	);
}

function lspConfigDisplay(lsp) {
	if (lsp === true) return 'true';
	if (lsp === false) return 'false';
	if (lsp === 'auto') return 'auto';
	if (Array.isArray(lsp)) return lsp.join(',') || '[]';
	return 'auto';
}
