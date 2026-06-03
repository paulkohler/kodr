import {
	OPENROUTER_BASE_URL,
	OPENROUTER_EXTRA_HEADERS,
} from './completion.mjs';

export const LMSTUDIO_BASE_URL = 'http://localhost:1234/v1';
export const OLLAMA_BASE_URL = 'http://localhost:11434/v1';
export { OPENROUTER_BASE_URL };

const PROVIDERS = new Set(['lmstudio', 'local', 'ollama', 'openrouter']);
const AGENTS = new Set(['planner', 'implementer', 'reviewer']);

export class ModelSpecError extends Error {
	constructor(message) {
		super(message);
		this.name = 'ModelSpecError';
	}
}

export function parseSlashModelSpec(spec, fallbackProvider = '') {
	if (!spec || typeof spec !== 'string') {
		throw new ModelSpecError('Model spec must be a non-empty string');
	}
	const slash = spec.indexOf('/');
	if (slash <= 0) {
		return {
			model: spec,
			provider: fallbackProvider || '',
			spec,
		};
	}
	const provider = spec.slice(0, slash).toLowerCase();
	if (!PROVIDERS.has(provider)) {
		return {
			model: spec,
			provider: fallbackProvider || '',
			spec,
		};
	}
	const model = spec.slice(slash + 1);
	if (!model) {
		throw new ModelSpecError(`Model spec is missing model id: ${spec}`);
	}
	return {
		model,
		provider,
		spec,
	};
}

export function resolveModelOptions(
	baseOptions,
	env = {},
	spec = '',
	options = {},
) {
	const parsed = parseSlashModelSpec(
		spec || baseOptions.model,
		baseOptions.provider || 'local',
	);
	const provider = normalizeProvider(parsed.provider || baseOptions.provider);
	if (provider === 'openrouter') {
		const apiKey =
			baseOptions.apiKey || env.OPENROUTER_API_KEY || env.OPENAI_API_KEY || '';
		if (!apiKey) {
			throw new ModelSpecError(
				'OpenRouter model specs require OPENROUTER_API_KEY, OPENAI_API_KEY, or --api-key',
			);
		}
		return {
			...baseOptions,
			apiKey,
			baseUrl: options.allowBaseUrlOverride
				? baseOptions.baseUrl
				: OPENROUTER_BASE_URL,
			extraHeaders: OPENROUTER_EXTRA_HEADERS,
			model: parsed.model,
			modelSpec: parsed.spec,
			provider,
		};
	}
	if (provider === 'ollama') {
		return {
			...baseOptions,
			baseUrl: shouldReuseBaseUrl(baseOptions, options, ['ollama'])
				? baseOptions.baseUrl
				: OLLAMA_BASE_URL,
			extraHeaders: {},
			model: parsed.model,
			modelSpec: parsed.spec,
			provider,
		};
	}
	return {
		...baseOptions,
		baseUrl: shouldReuseBaseUrl(baseOptions, options, ['local', 'lmstudio'])
			? baseOptions.baseUrl
			: LMSTUDIO_BASE_URL,
		extraHeaders: {},
		model: parsed.model,
		modelSpec: parsed.spec,
		provider,
	};
}

export function parseAgentModelOverride(value) {
	const equals = value.indexOf('=');
	if (equals <= 0) {
		throw new ModelSpecError(
			'--agent-model must use agent=provider/model syntax',
		);
	}
	const agent = value.slice(0, equals).trim().toLowerCase();
	const spec = value.slice(equals + 1).trim();
	if (!AGENTS.has(agent)) {
		throw new ModelSpecError(
			`Unknown --agent-model agent "${agent}". Expected planner, implementer, or reviewer`,
		);
	}
	if (!spec) {
		throw new ModelSpecError(`--agent-model ${agent}= requires a model spec`);
	}
	return { agent, spec };
}

export function resolveAgentModels(baseOptions, env = {}) {
	const resolved = {};
	for (const [agent, spec] of Object.entries(
		baseOptions.agentModelSpecs || {},
	)) {
		resolved[agent] = resolveModelOptions(baseOptions, env, spec);
	}
	return resolved;
}

function normalizeProvider(provider) {
	if (!provider || provider === 'local') {
		return 'local';
	}
	return provider;
}

function shouldReuseBaseUrl(baseOptions, options, providers) {
	return (
		options.allowBaseUrlOverride ||
		providers.includes(normalizeProvider(baseOptions.provider))
	);
}
