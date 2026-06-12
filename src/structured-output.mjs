export function proposalResponseFormat() {
	return jsonSchemaResponseFormat('kodr_proposal', {
		type: 'object',
		properties: {
			status: { type: 'string', enum: ['OK', 'ERROR'] },
			messages: {
				type: 'array',
				items: {
					type: 'object',
					properties: {
						level: { type: 'string' },
						content: { type: 'string' },
					},
					required: ['level', 'content'],
					additionalProperties: false,
				},
			},
			files: {
				type: 'array',
				items: {
					type: 'object',
					properties: {
						path: { type: 'string' },
						content: { type: 'string' },
					},
					required: ['path', 'content'],
					additionalProperties: false,
				},
			},
			patches: {
				type: 'array',
				items: {
					type: 'object',
					properties: {
						path: { type: 'string' },
						search: { type: 'string' },
						replace: { type: 'string' },
					},
					required: ['path', 'search', 'replace'],
					additionalProperties: false,
				},
			},
			scratchpad: { type: 'string' },
		},
		required: ['status', 'messages', 'files', 'patches', 'scratchpad'],
		additionalProperties: false,
	});
}

export function plannerResponseFormat() {
	return jsonSchemaResponseFormat('kodr_plan_manifest', {
		type: 'object',
		properties: {
			summary: { type: 'string' },
			files: {
				type: 'array',
				items: {
					type: 'object',
					properties: {
						path: { type: 'string' },
						responsibility: { type: 'string' },
						exports: { type: 'array', items: { type: 'string' } },
						imports: {
							type: 'array',
							items: {
								type: 'object',
								properties: {
									from: { type: 'string' },
									names: { type: 'array', items: { type: 'string' } },
								},
								required: ['from', 'names'],
								additionalProperties: false,
							},
						},
					},
					required: ['path', 'responsibility', 'exports', 'imports'],
					additionalProperties: false,
				},
			},
			verification: { type: 'string' },
		},
		required: ['summary', 'files'],
		additionalProperties: false,
	});
}

export function reviewResponseFormat() {
	return jsonSchemaResponseFormat('kodr_review', {
		type: 'object',
		properties: {
			pass: { type: 'boolean' },
			issues: {
				type: 'array',
				items: { type: 'string' },
			},
			summary: { type: 'string' },
		},
		required: ['pass', 'issues', 'summary'],
		additionalProperties: false,
	});
}

// Apply the response_format to a request body according to the profile's
// structuredOutput mode. The mode is read from options.structuredOutputMode
// (set by applyModelProfileDefaults from the resolved profile) with a fallback
// to the legacy options.provider heuristic for call sites not yet on profiles.
//
// Mode semantics:
//   'none'        — never attach response_format (local/LM Studio measured default)
//   'json_object' — attach { type: 'json_object' } (other OpenAI-compatible servers)
//   'json_schema' — attach the structured schema (cloud/OpenRouter default)
//
// The mode applies identically to every turn type: main turns, forced final turns,
// repair turns, and E4 nudge turns. The old shouldOmitResponseFormat heuristic
// (local + tools → omit) is deleted; the profile is the single source of truth.
export function applyResponseFormat(body, options) {
	const mode = resolveMode(options);
	if (mode === 'none') {
		// Ensure no lingering response_format on the body
		const { response_format: _rf, ...rest } = body;
		return rest;
	}
	if (mode === 'json_object') {
		return { ...body, response_format: { type: 'json_object' } };
	}
	// 'json_schema': attach the schema from options.responseFormat if present
	if (!options?.responseFormat) {
		return body;
	}
	if (body.response_format) {
		return body;
	}
	return {
		...body,
		response_format: options.responseFormat,
	};
}

export function responseFormatForRequest(body, options) {
	const mode = resolveMode(options);
	if (mode === 'none') {
		return null;
	}
	if (mode === 'json_object') {
		return { type: 'json_object' };
	}
	// 'json_schema'
	return options?.responseFormat || null;
}

// Resolve the effective structured-output mode. Prefers the profile-derived
// structuredOutputMode; falls back gracefully for call sites that pre-date
// profile threading (e.g. tests, plain completeWithContinuations callers).
function resolveMode(options) {
	const mode = options?.structuredOutputMode;
	if (mode === 'none' || mode === 'json_object' || mode === 'json_schema') {
		return mode;
	}
	// Legacy fallback: if no mode set, behave as 'none' for local providers
	// (preserves pre-S2 behavior for un-migrated call sites) and 'json_schema'
	// for everything else when a responseFormat is present.
	if (options?.provider === 'local' || options?.provider === 'lmstudio') {
		return 'none';
	}
	if (options?.responseFormat) {
		return 'json_schema';
	}
	return 'none';
}

function jsonSchemaResponseFormat(name, schema) {
	return {
		type: 'json_schema',
		json_schema: {
			name,
			strict: true,
			schema,
		},
	};
}
