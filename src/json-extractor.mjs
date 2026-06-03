export class JsonExtractionError extends Error {
	constructor(message) {
		super(message);
		this.name = 'JsonExtractionError';
	}
}

export class ProposalValidationError extends Error {
	constructor(message) {
		super(message);
		this.name = 'ProposalValidationError';
	}
}

export function extractJson(text) {
	if (typeof text !== 'string') {
		throw new JsonExtractionError('JSON extraction input must be a string');
	}

	const candidates = candidateTexts(text);
	const errors = [];

	for (const candidate of candidates) {
		const repaired = repairJsonText(candidate);
		try {
			assertNoDuplicateTopLevelKeys(repaired);
			return JSON.parse(repaired);
		} catch (error) {
			errors.push(error.message);
		}
	}

	throw new JsonExtractionError(`Could not extract JSON: ${errors.join('; ')}`);
}

export function extractProposal(text) {
	try {
		const value = extractJson(text);
		if (
			!value ||
			(!Array.isArray(value.files) &&
				!Array.isArray(value.patches) &&
				!Array.isArray(value.messages) &&
				typeof value.status !== 'string' &&
				typeof value.scratchpad !== 'string')
		) {
			return null;
		}

		const files = Array.isArray(value.files) ? value.files : [];
		const patches = Array.isArray(value.patches) ? value.patches : [];
		const messages = Array.isArray(value.messages) ? value.messages : [];
		const status = parseProposalStatus(value.status);

		return {
			files: files.map((file) => {
				if (
					!file ||
					typeof file.path !== 'string' ||
					typeof file.content !== 'string'
				) {
					throw new ProposalValidationError(
						'Proposal files must have string path and content',
					);
				}

				return {
					content: file.content,
					path: file.path,
				};
			}),
			messages: messages
				.filter(
					(message) =>
						message &&
						typeof message.level === 'string' &&
						typeof message.content === 'string',
				)
				.map((message) => ({
					content: message.content,
					level: message.level,
				})),
			scratchpad: typeof value.scratchpad === 'string' ? value.scratchpad : '',
			status,
			patches: patches.map((patch) => {
				if (
					!patch ||
					typeof patch.path !== 'string' ||
					typeof patch.search !== 'string' ||
					typeof patch.replace !== 'string'
				) {
					throw new ProposalValidationError(
						'Proposal patches must have string path, search, and replace',
					);
				}

				return {
					path: patch.path,
					replace: patch.replace,
					search: patch.search,
				};
			}),
		};
	} catch (error) {
		if (error instanceof JsonExtractionError) {
			return null;
		}
		throw error;
	}
}

function parseProposalStatus(value) {
	if (value === undefined) {
		return 'OK';
	}

	if (typeof value !== 'string') {
		throw new ProposalValidationError(
			'Proposal status must be "OK" or "ERROR"',
		);
	}

	const status = value.toUpperCase();
	if (status !== 'OK' && status !== 'ERROR') {
		throw new ProposalValidationError(
			'Proposal status must be "OK" or "ERROR"',
		);
	}

	return status;
}

export function findJsonText(text) {
	for (const candidate of candidateTexts(text)) {
		return candidate;
	}

	throw new JsonExtractionError('Could not find JSON braces or brackets');
}

function candidateTexts(text) {
	const candidates = [];
	for (const fenced of fencedJsonBlocks(text)) {
		candidates.push(fenced);
	}

	const braceCandidate = braceWalk(text);
	if (braceCandidate) {
		candidates.push(braceCandidate);
	}

	return [...new Set(candidates)];
}

function fencedJsonBlocks(text) {
	const blocks = [];
	const pattern = /```(?:json)?\s*([\s\S]*?)```/giu;
	let match = pattern.exec(text);

	while (match) {
		blocks.push(match[1].trim());
		match = pattern.exec(text);
	}

	return blocks;
}

function braceWalk(text) {
	const openIndex = firstJsonOpen(text);
	if (openIndex === -1) {
		return '';
	}

	const open = text[openIndex];
	const close = open === '{' ? '}' : ']';
	const stack = [close];
	let inString = false;
	let escaped = false;

	for (let index = openIndex + 1; index < text.length; index += 1) {
		const char = text[index];

		if (inString) {
			if (escaped) {
				escaped = false;
			} else if (char === '\\') {
				escaped = true;
			} else if (char === '"') {
				inString = false;
			}
			continue;
		}

		if (char === '"') {
			inString = true;
			continue;
		}

		if (char === '{') {
			stack.push('}');
			continue;
		}

		if (char === '[') {
			stack.push(']');
			continue;
		}

		if (char === '}' || char === ']') {
			const expected = stack.pop();
			if (char !== expected) {
				throw new JsonExtractionError('Mismatched JSON delimiters');
			}
			if (stack.length === 0) {
				return text.slice(openIndex, index + 1);
			}
		}
	}

	throw new JsonExtractionError('Unclosed JSON candidate');
}

function firstJsonOpen(text) {
	const objectIndex = text.indexOf('{');
	const arrayIndex = text.indexOf('[');

	if (objectIndex === -1) {
		return arrayIndex;
	}

	if (arrayIndex === -1) {
		return objectIndex;
	}

	return Math.min(objectIndex, arrayIndex);
}

function repairJsonText(text) {
	return repairRawStringControlChars(text).replaceAll('\\`', '`');
}

function repairRawStringControlChars(text) {
	let output = '';
	let inString = false;
	let escaped = false;

	for (const char of text) {
		if (inString) {
			if (escaped) {
				output += isValidJsonEscape(char) ? `\\${char}` : char;
				escaped = false;
				continue;
			}

			if (char === '\\') {
				escaped = true;
				continue;
			}

			if (char === '"') {
				output += char;
				inString = false;
				continue;
			}

			if (char === '\n') {
				output += '\\n';
				continue;
			}

			if (char === '\r') {
				output += '\\r';
				continue;
			}

			if (char === '\t') {
				output += '\\t';
				continue;
			}

			output += char;
			continue;
		}

		if (char === '"') {
			inString = true;
		}

		output += char;
	}

	return output;
}

function isValidJsonEscape(char) {
	return (
		char === '"' ||
		char === '\\' ||
		char === '/' ||
		char === 'b' ||
		char === 'f' ||
		char === 'n' ||
		char === 'r' ||
		char === 't' ||
		char === 'u'
	);
}

function assertNoDuplicateTopLevelKeys(text) {
	const start = firstNonWhitespace(text, 0);
	if (text[start] !== '{') {
		return;
	}

	const keys = new Set();
	let depth = 0;
	let inString = false;
	let escaped = false;

	for (let index = start; index < text.length; index += 1) {
		const char = text[index];

		if (inString) {
			if (escaped) {
				escaped = false;
			} else if (char === '\\') {
				escaped = true;
			} else if (char === '"') {
				inString = false;
			}
			continue;
		}

		if (char === '"') {
			const end = stringEnd(text, index);
			if (depth === 1) {
				const next = firstNonWhitespace(text, end + 1);
				if (text[next] === ':') {
					const key = text.slice(index + 1, end);
					if (keys.has(key)) {
						throw new JsonExtractionError(`Duplicate JSON key: ${key}`);
					}
					keys.add(key);
				}
			}
			index = end;
			continue;
		}

		if (char === '{' || char === '[') {
			depth += 1;
		} else if (char === '}' || char === ']') {
			depth -= 1;
		}
	}
}

function firstNonWhitespace(text, start) {
	for (let index = start; index < text.length; index += 1) {
		if (!/\s/u.test(text[index])) {
			return index;
		}
	}
	return -1;
}

function stringEnd(text, start) {
	let escaped = false;
	for (let index = start + 1; index < text.length; index += 1) {
		const char = text[index];
		if (escaped) {
			escaped = false;
		} else if (char === '\\') {
			escaped = true;
		} else if (char === '"') {
			return index;
		}
	}
	throw new JsonExtractionError('Unclosed JSON string');
}
