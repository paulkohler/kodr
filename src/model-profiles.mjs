import { readFileSync } from 'node:fs';
import { isAbsolute, resolve } from 'node:path';
import { LMSTUDIO_BASE_URL, OLLAMA_BASE_URL } from './model-specs.mjs';
import { OPENROUTER_BASE_URL } from './completion.mjs';

export const DEFAULT_CONTEXT_WINDOW = 32768;
export const DEFAULT_COMPLETION_RESERVE = 4096;
export const DEFAULT_TIMEOUT_MS = 600000;

const DEFAULT_PROFILES = [
	{
		baseUrl: LMSTUDIO_BASE_URL,
		completionReserve: 4096,
		contextWindow: 32768,
		id: 'qwen/qwen3.6-35b-a3b',
		nativeToolCalls: true,
		provider: 'local',
		responseEnvelope: 'json',
		timeoutMs: 600000,
	},
	{
		baseUrl: LMSTUDIO_BASE_URL,
		completionReserve: 4096,
		contextWindow: 32768,
		id: 'qwen/qwen3.6-35b-a3b',
		nativeToolCalls: true,
		provider: 'lmstudio',
		responseEnvelope: 'json',
		timeoutMs: 600000,
	},
	{
		baseUrl: LMSTUDIO_BASE_URL,
		completionReserve: 4096,
		contextWindow: 65536,
		id: 'nvidia/nemotron-3-nano-omni',
		nativeToolCalls: true,
		provider: 'local',
		responseEnvelope: 'json',
		timeoutMs: 600000,
	},
	{
		baseUrl: LMSTUDIO_BASE_URL,
		completionReserve: 4096,
		contextWindow: 65536,
		id: 'nvidia/nemotron-3-nano-omni',
		nativeToolCalls: true,
		provider: 'lmstudio',
		responseEnvelope: 'json',
		timeoutMs: 600000,
	},
	{
		baseUrl: OLLAMA_BASE_URL,
		completionReserve: 2048,
		contextWindow: 32768,
		id: '*',
		nativeToolCalls: true,
		provider: 'ollama',
		responseEnvelope: 'json',
		timeoutMs: 600000,
	},
	{
		baseUrl: OPENROUTER_BASE_URL,
		completionReserve: 8192,
		contextWindow: 128000,
		id: '*',
		nativeToolCalls: true,
		provider: 'openrouter',
		responseEnvelope: 'json_schema',
		timeoutMs: 600000,
	},
];

export function loadModelProfiles(cwd = process.cwd(), env = {}) {
	const profiles = new Map();
	for (const profile of DEFAULT_PROFILES) {
		addProfile(profiles, normalizeProfile(profile, 'builtin'));
	}
	const configPath = resolveProfileConfigPath(cwd, env);
	if (configPath) {
		const parsed = JSON.parse(readFileSync(configPath, 'utf8'));
		for (const profile of parseConfiguredProfiles(parsed)) {
			addProfile(profiles, normalizeProfile(profile, configPath));
		}
	}
	return { configPath, profiles };
}

export function resolveModelProfile(options, env = {}, cwd = process.cwd()) {
	const loaded = loadModelProfiles(cwd, env);
	const provider = normalizeProvider(options.provider || 'local');
	const model = options.model || '';
	const profile =
		loaded.profiles.get(profileKey(provider, model)) ||
		loaded.profiles.get(profileKey(provider, '*')) ||
		fallbackProfile(provider, model, options);
	return {
		...profile,
		configPath: loaded.configPath || '',
		key: profileKey(profile.provider, profile.id),
		matched:
			loaded.profiles.has(profileKey(provider, model)) ||
			loaded.profiles.has(profileKey(provider, '*')),
	};
}

export function applyModelProfileDefaults(
	options,
	env = {},
	cwd = process.cwd(),
) {
	const profile = resolveModelProfile(options, env, cwd);
	const contextWindow = options._contextWindowSet
		? options.contextWindow
		: profile.contextWindow;
	const completionReserve = options._completionReserveSet
		? options.completionReserve
		: profile.completionReserve;
	const effectiveProfile = {
		...profile,
		completionReserve,
		contextWindow,
	};
	const next = {
		...options,
		completionReserve,
		contextBudgetChars: Math.min(
			sessionContextCharsForProfile(effectiveProfile),
			80000,
		),
		contextWindow,
		modelProfile: serializeProfile(profile),
		nativeToolCalls: profile.nativeToolCalls,
		responseEnvelopeMode: profile.responseEnvelope,
	};
	if (!options._timeoutSet) {
		next.timeoutMs = profile.timeoutMs;
	}
	if (!options._sessionContextSet) {
		next.sessionContextChars = sessionContextCharsForProfile(effectiveProfile);
	}
	return next;
}

export function sessionContextCharsForProfile(profile) {
	const usableTokens = Math.max(
		1000,
		(profile.contextWindow || DEFAULT_CONTEXT_WINDOW) -
			(profile.completionReserve || DEFAULT_COMPLETION_RESERVE),
	);
	// A conservative 4 chars/token estimate keeps compaction below the profile
	// window without requiring a tokenizer dependency.
	return usableTokens * 4;
}

function addProfile(profiles, profile) {
	profiles.set(profileKey(profile.provider, profile.id), profile);
}

function normalizeProfile(profile, source) {
	const provider = normalizeProvider(profile.provider || 'local');
	const id = stringValue(profile.id || profile.model || '*');
	return {
		baseUrl: stringValue(profile.baseUrl || defaultBaseUrl(provider)),
		completionReserve: positiveInteger(
			profile.completionReserve,
			DEFAULT_COMPLETION_RESERVE,
		),
		contextWindow: positiveInteger(
			profile.contextWindow,
			DEFAULT_CONTEXT_WINDOW,
		),
		id,
		nativeToolCalls: profile.nativeToolCalls !== false,
		provider,
		responseEnvelope: stringValue(profile.responseEnvelope || 'json'),
		source,
		timeoutMs: positiveInteger(profile.timeoutMs, DEFAULT_TIMEOUT_MS),
	};
}

function parseConfiguredProfiles(parsed) {
	if (Array.isArray(parsed)) {
		return parsed;
	}
	if (Array.isArray(parsed?.profiles)) {
		return parsed.profiles;
	}
	if (parsed?.profiles && typeof parsed.profiles === 'object') {
		return Object.entries(parsed.profiles).map(([key, value]) => ({
			...value,
			...parseProfileKey(key),
		}));
	}
	return [];
}

function parseProfileKey(key) {
	const slash = key.indexOf('/');
	if (slash <= 0) {
		return { id: key, provider: 'local' };
	}
	return {
		id: key.slice(slash + 1),
		provider: key.slice(0, slash),
	};
}

function resolveProfileConfigPath(cwd, env) {
	const configured = env.KODR_MODEL_PROFILES || '';
	if (configured) {
		return isAbsolute(configured) ? configured : resolve(cwd, configured);
	}
	try {
		const path = resolve(cwd, '.kodr/model-profiles.json');
		readFileSync(path, 'utf8');
		return path;
	} catch {
		return '';
	}
}

function fallbackProfile(provider, model, options = {}) {
	return normalizeProfile(
		{
			baseUrl: options.baseUrl || defaultBaseUrl(provider),
			completionReserve: DEFAULT_COMPLETION_RESERVE,
			contextWindow: DEFAULT_CONTEXT_WINDOW,
			id: model || '*',
			nativeToolCalls: true,
			provider,
			responseEnvelope: 'json',
			timeoutMs: DEFAULT_TIMEOUT_MS,
		},
		'fallback',
	);
}

function serializeProfile(profile) {
	return {
		baseUrl: profile.baseUrl,
		completionReserve: profile.completionReserve,
		configPath: profile.configPath,
		contextWindow: profile.contextWindow,
		id: profile.id,
		key: profile.key,
		matched: profile.matched,
		nativeToolCalls: profile.nativeToolCalls,
		provider: profile.provider,
		responseEnvelope: profile.responseEnvelope,
		source: profile.source,
		timeoutMs: profile.timeoutMs,
	};
}

function profileKey(provider, id) {
	return `${normalizeProvider(provider)}/${id}`;
}

function normalizeProvider(provider) {
	return provider === 'lmstudio' ? 'lmstudio' : provider || 'local';
}

function defaultBaseUrl(provider) {
	if (provider === 'ollama') {
		return OLLAMA_BASE_URL;
	}
	if (provider === 'openrouter') {
		return OPENROUTER_BASE_URL;
	}
	return LMSTUDIO_BASE_URL;
}

function stringValue(value) {
	return typeof value === 'string' ? value : String(value || '');
}

function positiveInteger(value, fallback) {
	return Number.isInteger(value) && value > 0 ? value : fallback;
}
