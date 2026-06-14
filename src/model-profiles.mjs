import { readFileSync } from 'node:fs';
import { isAbsolute, resolve } from 'node:path';
import { normalizeEditFormat } from './edit-formats.mjs';
import { LMSTUDIO_BASE_URL, OLLAMA_BASE_URL } from './model-specs.mjs';
import { OPENROUTER_BASE_URL } from './completion.mjs';
import { loadRoutingTableSync } from './bench.mjs';
import {
	loadProbeResultsSync,
	resolveToolWritesMode,
} from './probe-persistence.mjs';

export const DEFAULT_CONTEXT_WINDOW = 32768;
export const DEFAULT_COMPLETION_RESERVE = 4096;
export const DEFAULT_TIMEOUT_MS = 600000;
export const DEFAULT_FIRST_TOKEN_TIMEOUT_MS = 120000;

// Valid structuredOutput modes. 'json_object' is excluded for LM Studio profiles
// (the server returns HTTP 400 — only 'json_schema' or 'text' are accepted).
// Measured defaults: 'none' for all local/LM Studio profiles (json_schema stalls
// both qwen3.6 and gemma-4; phase 110 + phase 112 A/B). Cloud/OpenRouter: 'json_schema'.
const VALID_STRUCTURED_OUTPUT_MODES = new Set([
	'json_schema',
	'json_object',
	'none',
]);

// Valid toolWrites modes (phase 118).
//   'native'   — capture tools are the primary write path; prompt makes them explicit.
//   'envelope' — capture tools NOT declared; pre-117 prompt surface (for models
//                the measurements say are confused by tools).
//   'auto'     — 117 behaviour (both channels, neutral wording) when no probe.json
//                measurement; resolves to 'native' when probe.json says native for
//                this (baseUrl, model).
const VALID_TOOL_WRITES_MODES = new Set(['native', 'envelope', 'auto']);

// Providers whose server rejects json_object with HTTP 400.
const NO_JSON_OBJECT_PROVIDERS = new Set(['local', 'lmstudio']);

const DEFAULT_PROFILES = [
	{
		baseUrl: LMSTUDIO_BASE_URL,
		completionReserve: 4096,
		contextWindow: 32768,
		firstTokenTimeoutMs: 120000,
		id: 'qwen/qwen3.6-35b-a3b',
		nativeToolCalls: true,
		provider: 'local',
		responseEnvelope: 'json',
		structuredOutput: 'none',
		timeoutMs: 600000,
	},
	{
		baseUrl: LMSTUDIO_BASE_URL,
		completionReserve: 4096,
		contextWindow: 32768,
		firstTokenTimeoutMs: 120000,
		id: 'qwen/qwen3.6-35b-a3b',
		nativeToolCalls: true,
		provider: 'lmstudio',
		responseEnvelope: 'json',
		structuredOutput: 'none',
		timeoutMs: 600000,
	},
	{
		baseUrl: LMSTUDIO_BASE_URL,
		completionReserve: 4096,
		contextWindow: 65536,
		firstTokenTimeoutMs: 120000,
		id: 'nvidia/nemotron-3-nano-omni',
		nativeToolCalls: true,
		provider: 'local',
		responseEnvelope: 'json',
		structuredOutput: 'none',
		timeoutMs: 600000,
	},
	{
		baseUrl: LMSTUDIO_BASE_URL,
		completionReserve: 4096,
		contextWindow: 65536,
		firstTokenTimeoutMs: 120000,
		id: 'nvidia/nemotron-3-nano-omni',
		nativeToolCalls: true,
		provider: 'lmstudio',
		responseEnvelope: 'json',
		structuredOutput: 'none',
		timeoutMs: 600000,
	},
	{
		baseUrl: OLLAMA_BASE_URL,
		completionReserve: 2048,
		contextWindow: 32768,
		firstTokenTimeoutMs: 120000,
		id: '*',
		nativeToolCalls: true,
		provider: 'ollama',
		responseEnvelope: 'json',
		structuredOutput: 'none',
		timeoutMs: 600000,
	},
	{
		baseUrl: OPENROUTER_BASE_URL,
		completionReserve: 8192,
		contextWindow: 128000,
		firstTokenTimeoutMs: 120000,
		id: '*',
		nativeToolCalls: true,
		provider: 'openrouter',
		responseEnvelope: 'json_schema',
		structuredOutput: 'json_schema',
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
			const normalized = normalizeProfile(profile, configPath);
			validateStructuredOutputMode(normalized);
			addProfile(profiles, normalized);
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
		contextBudgetChars: contextBudgetCharsForWindow(
			contextWindow,
			completionReserve,
		),
		contextWindow,
		modelProfile: serializeProfile(profile),
		nativeToolCalls: profile.nativeToolCalls,
		responseEnvelopeMode: profile.responseEnvelope,
		structuredOutputMode: profile.structuredOutput,
		// W2: profile toolAliases override the built-in DEFAULT_TOOL_ALIASES in
		// createBuiltinRegistry. Only set when the profile explicitly declares aliases.
		...(profile.toolAliases ? { profileToolAliases: profile.toolAliases } : {}),
	};
	if (!options._timeoutSet) {
		next.timeoutMs = profile.timeoutMs;
	}
	if (!options._firstTokenTimeoutSet) {
		next.firstTokenTimeoutMs = profile.firstTokenTimeoutMs;
	}
	if (!options._editFormatSet) {
		next.editFormat = profile.editFormat;
	}
	if (options.tools === 'auto') {
		next.tools = profile.nativeToolCalls;
	}
	if (!options._sessionContextSet) {
		next.sessionContextChars = sessionContextCharsForProfile(effectiveProfile);
	}
	// Load routing table from .kodr/routing.json if present. Advisory only —
	// does not auto-override options.model. Consumers may read routingTable to
	// suggest an alternate model.
	const routingTable = loadRoutingTableSync(cwd);
	if (routingTable !== null) {
		next.routingTable = routingTable;
	}
	// T3: resolve toolWrites mode. Profile declares 'native'|'envelope'|'auto';
	// auto is resolved against probe.json if present. The resolved mode is stored
	// as toolWritesMode (the profile's raw setting stays in modelProfile.toolWrites).
	const probeData = loadProbeResultsSync(cwd);
	next.toolWritesMode = resolveToolWritesMode(
		profile.toolWrites,
		probeData,
		options.baseUrl || '',
		options.model || '',
	);
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

// Phase 146: compute the workspace-context packing budget from the active context
// window. Scales with context window so large-context models (131K+) actually use
// the extra capacity instead of being capped at the 32K-era 80 000-char ceiling.
//
// Formula: min(320 000, max(80 000, contextWindow * 2))
//   32 768 → 80 000 chars (≈ 20 K tokens) — unchanged from prior cap
//   131 072 → 262 144 chars (≈ 65 K tokens)
//   262 144 → 320 000 chars (≈ 80 K tokens, ceiling)
export function contextBudgetCharsForWindow(
	contextWindow,
	completionReserve = DEFAULT_COMPLETION_RESERVE,
) {
	const raw = sessionContextCharsForProfile({
		contextWindow,
		completionReserve,
	});
	const scaledCap = Math.min(320000, Math.max(80000, contextWindow * 2));
	return Math.min(raw, scaledCap);
}

// Phase 146: probe the LM Studio /api/v0/models/{model} endpoint for the
// actual loaded context length. Returns the integer loaded_context_length when
// found, null on any error or missing field. Callers should prefer this value
// over the static profile when not explicitly overridden by --context-window.
export async function probeLMStudioContextWindow(baseUrl, model) {
	if (!baseUrl || !model) return null;
	try {
		const origin = new URL(baseUrl).origin;
		// Model IDs contain slashes (e.g. mistralai/devstral-small-2-2512);
		// encode each segment so the path is valid.
		const encodedModel = model
			.split('/')
			.map((s) => encodeURIComponent(s))
			.join('/');
		const url = `${origin}/api/v0/models/${encodedModel}`;
		const response = await fetch(url, { signal: AbortSignal.timeout(3000) });
		if (!response.ok) return null;
		const data = await response.json();
		const loaded = data?.loaded_context_length;
		return Number.isInteger(loaded) && loaded > 0 ? loaded : null;
	} catch {
		return null;
	}
}

function addProfile(profiles, profile) {
	profiles.set(profileKey(profile.provider, profile.id), profile);
}

function normalizeProfile(profile, source) {
	const provider = normalizeProvider(profile.provider || 'local');
	const id = stringValue(profile.id || profile.model || '*');
	// Default structuredOutput based on provider: local/lmstudio/ollama → none
	// (measured: json_schema stalls; json_object HTTP 400 on LM Studio),
	// openrouter → json_schema (current cloud behavior).
	const defaultStructuredOutput =
		provider === 'openrouter' ? 'json_schema' : 'none';
	const structuredOutput = VALID_STRUCTURED_OUTPUT_MODES.has(
		profile.structuredOutput,
	)
		? profile.structuredOutput
		: defaultStructuredOutput;
	// toolAliases: model-specific alias → canonical tool name map. Profiles can
	// override or extend the built-in DEFAULT_TOOL_ALIASES (W2).
	const toolAliases =
		profile.toolAliases && typeof profile.toolAliases === 'object'
			? { ...profile.toolAliases }
			: null;
	// toolWrites: channel preference — 'native' | 'envelope' | 'auto' (default).
	const toolWrites = VALID_TOOL_WRITES_MODES.has(profile.toolWrites)
		? profile.toolWrites
		: 'auto';
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
		editFormat: normalizeEditFormat(profile.editFormat),
		firstTokenTimeoutMs: positiveInteger(
			profile.firstTokenTimeoutMs,
			DEFAULT_FIRST_TOKEN_TIMEOUT_MS,
		),
		id,
		nativeToolCalls: profile.nativeToolCalls !== false,
		provider,
		responseEnvelope: stringValue(profile.responseEnvelope || 'json'),
		source,
		structuredOutput,
		timeoutMs: positiveInteger(profile.timeoutMs, DEFAULT_TIMEOUT_MS),
		toolWrites,
		...(toolAliases !== null ? { toolAliases } : {}),
	};
}

// Loudly reject a profile config that would send json_object to LM Studio.
// LM Studio only accepts 'json_schema' or 'text'; json_object returns HTTP 400.
function validateStructuredOutputMode(profile) {
	if (
		NO_JSON_OBJECT_PROVIDERS.has(profile.provider) &&
		profile.structuredOutput === 'json_object'
	) {
		throw new Error(
			`Profile "${profile.provider}/${profile.id}" sets structuredOutput: "json_object" ` +
				`but LM Studio rejects that mode (HTTP 400 — only "json_schema" or "text" are ` +
				`accepted). Use "json_schema" or "none" instead.`,
		);
	}
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
	const serialized = {
		baseUrl: profile.baseUrl,
		completionReserve: profile.completionReserve,
		configPath: profile.configPath,
		contextWindow: profile.contextWindow,
		editFormat: profile.editFormat,
		firstTokenTimeoutMs: profile.firstTokenTimeoutMs,
		id: profile.id,
		key: profile.key,
		matched: profile.matched,
		nativeToolCalls: profile.nativeToolCalls,
		provider: profile.provider,
		responseEnvelope: profile.responseEnvelope,
		source: profile.source,
		structuredOutput: profile.structuredOutput,
		timeoutMs: profile.timeoutMs,
		toolWrites: profile.toolWrites,
	};
	if (profile.toolAliases) {
		serialized.toolAliases = profile.toolAliases;
	}
	return serialized;
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
