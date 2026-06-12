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
			assertNoDuplicateKeys(repaired);
			return JSON.parse(repaired);
		} catch (error) {
			errors.push(error.message);
		}
	}

	throw new JsonExtractionError(`Could not extract JSON: ${errors.join('; ')}`);
}

export function extractProposal(text) {
	if (typeof text !== 'string') {
		return null;
	}

	const candidates = candidateTexts(text);
	const envelopes = [];
	// Track the first ProposalValidationError so it can be rethrown if no
	// valid envelope is found — this preserves the original contract that
	// structural malformation (e.g. patch missing "replace") surfaces as an
	// error rather than silently returning null.
	let firstValidationError = null;

	for (const candidate of candidates) {
		const repaired = repairJsonText(candidate);
		let value;
		try {
			assertNoDuplicateKeys(repaired);
			value = JSON.parse(repaired);
		} catch {
			continue;
		}

		if (
			!value ||
			(!Array.isArray(value.files) &&
				!Array.isArray(value.patches) &&
				!Array.isArray(value.messages) &&
				typeof value.status !== 'string' &&
				typeof value.scratchpad !== 'string')
		) {
			continue;
		}

		try {
			const envelope = parseProposalEnvelope(value);
			envelopes.push(envelope);
		} catch (error) {
			if (error instanceof ProposalValidationError && !firstValidationError) {
				firstValidationError = error;
			}
		}
	}

	if (envelopes.length === 0) {
		// Re-surface the first structural validation error if no valid envelope
		// was extracted — so callers can record it as a proposalError.
		if (firstValidationError) {
			throw firstValidationError;
		}
		return null;
	}

	const merged = mergeProposalEnvelopes(envelopes);
	const meta = {
		candidateCount: candidates.length,
		proposalCount: envelopes.length,
		merged: envelopes.length > 1,
	};
	merged._extractionMeta = meta;
	return merged;
}

function parseProposalEnvelope(value) {
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
}

// Merge multiple proposal envelopes extracted from one model response.
// Files: last-wins per path (document order — later blocks override earlier).
// Patches, messages: concatenated in document order.
// Status, scratchpad: from the last envelope that sets them.
function mergeProposalEnvelopes(envelopes) {
	if (envelopes.length === 1) {
		return { ...envelopes[0] };
	}

	const fileMap = new Map();
	const allPatches = [];
	const allMessages = [];
	let status = 'OK';
	let scratchpad = '';

	for (const envelope of envelopes) {
		for (const file of envelope.files) {
			fileMap.set(file.path, file);
		}
		allPatches.push(...envelope.patches);
		allMessages.push(...envelope.messages);
		if (envelope.status) {
			status = envelope.status;
		}
		if (envelope.scratchpad) {
			scratchpad = envelope.scratchpad;
		}
	}

	return {
		files: Array.from(fileMap.values()),
		messages: allMessages,
		patches: allPatches,
		scratchpad,
		status,
	};
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

// Maximum number of brace-walk retry attempts after a failed region.
// Large enough to skip over a dense burst of garbage braces, small enough
// to avoid scanning the whole document on adversarial input.
const MAX_BRACE_RETRIES = 16;

function candidateTexts(text) {
	const candidates = [];
	for (const fenced of fencedJsonBlocks(text)) {
		candidates.push(fenced);
	}

	// Attempt brace walks from each new open position, skipping failed regions.
	// Bounded by MAX_BRACE_RETRIES so a text full of garbage does not loop forever.
	let searchFrom = 0;
	let retries = 0;
	while (retries < MAX_BRACE_RETRIES) {
		const openIndex = firstJsonOpenFrom(text, searchFrom);
		if (openIndex === -1) {
			break;
		}
		try {
			const candidate = braceWalkFrom(text, openIndex);
			if (candidate) {
				candidates.push(candidate);
			}
			// Advance past this candidate to avoid finding the same region again.
			searchFrom = openIndex + candidate.length;
		} catch {
			// This open brace started a malformed region — skip past it and try
			// the next open brace.
			searchFrom = openIndex + 1;
		}
		retries += 1;
	}

	return [...new Set(candidates)];
}

// Line-anchored fence pattern: opening ``` must be at the start of a line.
// This prevents interleaved or nested fences from being mis-paired.
function fencedJsonBlocks(text) {
	const blocks = [];
	// Split on lines that consist solely of a fence marker (``` or ```json).
	// This handles the real gemma-4 pattern where consecutive ```json lines
	// appear without a closing ``` between them.
	const lines = text.split('\n');
	let inBlock = false;
	const blockLines = [];

	for (const line of lines) {
		const isFenceOpen = /^```json\s*$/iu.test(line);
		const isFenceClose = /^```\s*$/u.test(line);

		if (!inBlock) {
			if (isFenceOpen) {
				inBlock = true;
				blockLines.length = 0;
			}
			// A plain ``` line outside a block is ignored
		} else {
			if (isFenceClose) {
				blocks.push(blockLines.join('\n').trim());
				inBlock = false;
			} else if (isFenceOpen) {
				// A new ```json opens before the previous block closed —
				// save what we have and start a new block.
				if (blockLines.length > 0) {
					blocks.push(blockLines.join('\n').trim());
				}
				blockLines.length = 0;
			} else {
				blockLines.push(line);
			}
		}
	}

	// Unclosed final block — still usable if it has content.
	if (inBlock && blockLines.length > 0) {
		blocks.push(blockLines.join('\n').trim());
	}

	return blocks.filter((b) => b.length > 0);
}

function braceWalkFrom(text, openIndex) {
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

function firstJsonOpenFrom(text, from) {
	const objectIndex = text.indexOf('{', from);
	const arrayIndex = text.indexOf('[', from);

	if (objectIndex === -1) {
		return arrayIndex;
	}

	if (arrayIndex === -1) {
		return objectIndex;
	}

	return Math.min(objectIndex, arrayIndex);
}

// Decode-artifact substitution rules: model-emitted pseudo-tokens that corrupt
// JSON and must be replaced with their intended character. The list is ordered
// by specificity (longest match first) and is meant to grow one entry per newly
// observed model artifact.
//
// Provenance: <|"|> confirmed in google/gemma-4-26b-a4b output on LM Studio
// (~/src/kodr-testing/phase-111/gemma-smoke-2/.kodr/runs/2026-06-12T06-54-00.966Z/response.md,
// 7 occurrences — every fenced envelope corrupted). The token appears where an
// escaped or closing quote belongs inside a JSON string value.
const DECODE_ARTIFACT_RULES = [{ from: '<|"|>', to: '"' }];

function repairJsonText(text) {
	let result = text;
	for (const rule of DECODE_ARTIFACT_RULES) {
		result = result.replaceAll(rule.from, rule.to);
	}
	return repairRawStringControlChars(result).replaceAll('\\`', '`');
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

// Detect duplicate keys at any object depth, not just top level.
// Per-object key sets are tracked as the walker descends and ascends.
function assertNoDuplicateKeys(text) {
	const start = firstNonWhitespace(text, 0);
	if (text[start] !== '{' && text[start] !== '[') {
		return;
	}

	// Stack of {open char, seen-keys Set} for each open object.
	// Arrays do not have keys so they push null.
	const stack = [];
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
			// Check if this string is a key in the current object.
			const frame = stack.at(-1);
			if (frame !== null && frame !== undefined) {
				const next = firstNonWhitespace(text, end + 1);
				if (text[next] === ':') {
					const key = text.slice(index + 1, end);
					if (frame.has(key)) {
						throw new JsonExtractionError(`Duplicate JSON key: ${key}`);
					}
					frame.add(key);
				}
			}
			index = end;
			inString = false;
			continue;
		}

		if (char === '{') {
			stack.push(new Set());
		} else if (char === '[') {
			stack.push(null);
		} else if (char === '}' || char === ']') {
			stack.pop();
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
