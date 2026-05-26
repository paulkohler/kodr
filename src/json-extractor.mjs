export class JsonExtractionError extends Error {
	constructor(message) {
		super(message);
		this.name = 'JsonExtractionError';
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
			return JSON.parse(repaired);
		} catch (error) {
			errors.push(error.message);
		}
	}

	throw new JsonExtractionError(`Could not extract JSON: ${errors.join('; ')}`);
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
				output += char;
				escaped = false;
				continue;
			}

			if (char === '\\') {
				output += char;
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
