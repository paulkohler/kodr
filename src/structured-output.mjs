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

export function applyResponseFormat(body, options) {
	if (!options?.responseFormat) {
		return body;
	}
	if (shouldOmitResponseFormat(body, options)) {
		const { response_format: _responseFormat, ...rest } = body;
		return rest;
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
	return shouldOmitResponseFormat(body, options)
		? null
		: options?.responseFormat || null;
}

function shouldOmitResponseFormat(body, options) {
	return (
		options?.provider === 'local' &&
		Array.isArray(body?.tools) &&
		body.tools.length > 0
	);
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
