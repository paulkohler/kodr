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

	const errors = [];

	function tryExtractFromCandidates(candidates) {
		for (const candidate of candidates) {
			// First attempt: blanket rules only (safe, never mutates valid JSON).
			const { text: repaired } = repairJsonText(candidate);
			try {
				assertNoDuplicateKeys(repaired);
				return JSON.parse(repaired);
			} catch (error) {
				errors.push(error.message);
			}

			// Second attempt: structural rules (repair path — safe to mutate since
			// the first attempt already failed to parse).
			const { text: repairedStructural } = repairJsonText(candidate, {
				structural: true,
			});
			if (repairedStructural !== repaired) {
				try {
					assertNoDuplicateKeys(repairedStructural);
					return JSON.parse(repairedStructural);
				} catch (error) {
					errors.push(error.message);
				}
			}
		}
		return undefined;
	}

	// Candidate resolution strategy:
	//
	// 1. Apply the unclosed-file-object repair rule to the full text to produce
	//    a structurally-repaired version and enumerate additional candidates from
	//    it. This rule is applied to the full text (rather than per-candidate)
	//    because outer-level corruption prevents braceWalkFrom from producing the
	//    outer object as a candidate at all. Without this step, the brace-walker
	//    falls back to inner candidates (e.g. the messages array) that parse as
	//    valid JSON but are not the intended result.
	//    Only this specific rule is applied here (not all structural rules) to
	//    avoid unintended transformations such as the qwen-duplicate-key-cluster
	//    split, which would silently mask duplicate-key errors.
	//
	// 2. Try structurally-repaired candidates FIRST (before raw candidates), so
	//    the repaired outer envelope wins over any inner candidate that happens
	//    to parse cleanly.
	//
	// 3. Fall back to raw candidates (with blanket + per-candidate structural
	//    repair) for inputs where the unclosed-object rule did not fire.
	// Apply the two full-text structural-completion rules (R4 unclosed-file-object,
	// then R6 truncated-envelope-tail) so the outer object becomes brace-walkable
	// and is enumerated as a candidate. R5 (duplicate-key split) is deliberately
	// NOT applied here — extractJson must not silently mask genuine duplicate-key
	// errors (the proposal path handles the R5+R6 combo via applyStructuralRules).
	const rawCandidates = candidateTexts(text);
	const { text: unclosedRepaired, fixCount: unclosedFixCount } =
		applyUnclosedFileObjectRule(text);
	const { text: prepassRepaired, fixCount: truncatedFixCount } =
		applyTruncatedEnvelopeRule(unclosedRepaired);
	const prepassFixCount = unclosedFixCount + truncatedFixCount;
	const repairedCandidates =
		prepassFixCount > 0 ? candidateTexts(prepassRepaired) : rawCandidates;

	// Candidates unique to the repaired pass (not already in rawCandidates).
	const repairedOnlyCandidates = repairedCandidates.filter(
		(c) => !rawCandidates.includes(c),
	);

	// Try repaired candidates first (the outer envelope, now parse-able),
	// then fall through to raw candidates.
	const orderedCandidates = [...repairedOnlyCandidates, ...rawCandidates];

	const result = tryExtractFromCandidates(orderedCandidates);
	if (result !== undefined) {
		return result;
	}

	throw new JsonExtractionError(`Could not extract JSON: ${errors.join('; ')}`);
}

export function extractProposal(text) {
	if (typeof text !== 'string') {
		return null;
	}

	// Accumulate fired repair rule counts across all candidates.
	const repairCounts = new Map();

	function recordRepairs(repairs) {
		for (const { ruleId, count } of repairs) {
			repairCounts.set(ruleId, (repairCounts.get(ruleId) ?? 0) + count);
		}
	}

	// Attempt to extract proposal envelopes from a set of candidate texts.
	// For each candidate:
	//   1. Apply blanket rules → try to parse (safe, never mutates valid JSON).
	//   2. If that fails, apply structural rules + blanket rules → try again
	//      (repair path — safe because the first attempt already failed).
	function extractFromCandidates(candidates) {
		const envelopes = [];
		let firstValidationError = null;

		const tryEnvelope = (repairedText) => {
			let value;
			try {
				assertNoDuplicateKeys(repairedText);
				value = JSON.parse(repairedText);
			} catch {
				return false;
			}

			if (
				!value ||
				(!Array.isArray(value.files) &&
					!Array.isArray(value.patches) &&
					!Array.isArray(value.messages) &&
					typeof value.status !== 'string' &&
					typeof value.scratchpad !== 'string')
			) {
				return false;
			}

			try {
				const envelope = parseProposalEnvelope(value);
				envelopes.push(envelope);
				return true;
			} catch (error) {
				if (error instanceof ProposalValidationError && !firstValidationError) {
					firstValidationError = error;
				}
				return false;
			}
		};

		for (const candidate of candidates) {
			// Blanket rules only first — these are safe on any text.
			const { text: repaired, repairs } = repairJsonText(candidate);
			recordRepairs(repairs);

			const parsed = tryEnvelope(repaired);

			if (!parsed) {
				// Structural rules (repair path only — safe because the candidate
				// already failed to parse without structural repair).
				const { text: repairedStructural, repairs: allRepairs } =
					repairJsonText(candidate, {
						structural: true,
					});
				if (repairedStructural !== repaired) {
					// Only record the structural-rule repairs (blanket already recorded above).
					const structuralOnly = allRepairs.filter((r) =>
						DECODE_ARTIFACT_RULES.find(
							(d) => d.ruleId === r.ruleId && d.type === 'structural',
						),
					);
					recordRepairs(structuralOnly);
					tryEnvelope(repairedStructural);
				}
			}
		}

		return { envelopes, firstValidationError };
	}

	// First pass: try extraction on the original text (brace-walked candidates).
	// Each candidate gets: blanket-rules-only attempt first; if that fails, a
	// structural+blanket attempt (repair path — the failed parse is the gate).
	const candidates = candidateTexts(text);
	let { envelopes, firstValidationError } = extractFromCandidates(candidates);

	// Second pass: if still no envelopes, apply structural rules to the full
	// text and re-enumerate candidates. Array-boundary corruption (gpt-oss
	// pattern) can prevent braceWalkFrom from producing any candidate at all
	// because the structural corruption appears at the outer level where the
	// brace-walker tracks nesting. Re-running candidateTexts on the repaired
	// full text allows the brace-walker to succeed.
	if (envelopes.length === 0) {
		const { text: structuralText, repairs: structuralRepairs } =
			applyStructuralRules(text);
		if (structuralText !== text) {
			// Record structural repairs from the full-text pass.
			const structuralOnly = structuralRepairs.filter((r) =>
				DECODE_ARTIFACT_RULES.find(
					(d) => d.ruleId === r.ruleId && d.type === 'structural',
				),
			);
			recordRepairs(structuralOnly);
			const structuralCandidates = candidateTexts(structuralText);
			const secondPass = extractFromCandidates(structuralCandidates);
			if (secondPass.envelopes.length > 0) {
				envelopes = secondPass.envelopes;
				firstValidationError = secondPass.firstValidationError;
			} else if (secondPass.firstValidationError && !firstValidationError) {
				firstValidationError = secondPass.firstValidationError;
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
	const firedRepairs =
		repairCounts.size > 0
			? Array.from(repairCounts.entries()).map(([ruleId, count]) => ({
					ruleId,
					count,
				}))
			: undefined;
	const meta = {
		candidateCount: candidates.length,
		proposalCount: envelopes.length,
		merged: envelopes.length > 1,
		...(firedRepairs ? { repairs: firedRepairs } : {}),
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
// Each rule has a stable ruleId used in _extractionMeta.repairs forensics.
//
// Rule ordering rationale:
//   R1 (gemma-collapsed-key): must run BEFORE the blanket <|"|> rule (R0).
//     gemma collapses `"key":"` into `"key:<|"|>`. Running the blanket rule
//     first yields `"key:"value` — still unparseable. The structural rule
//     yields `"key":"value` which parses correctly.
//   R2a (gpt-oss-stray-quote): `},"{"` → `},{"` — stray quote before `{`.
//   R2b (gpt-oss-missing-brace): `},"<key>":` → `},{"<key>":` — missing `{`.
//     Both R2 rules are structural and MUST only run in the repair path
//     (after a parse failure) to avoid corrupting valid string values.
//   R4 (gpt-oss-unclosed-file-object): position-aware scan that inserts the
//     missing `}` when a file object in the files array is never closed before `]`.
//     Shape: "files":[{"path":"...","content":"..."  ] → insert } before ].
//   R5 (qwen-duplicate-key-cluster): position-aware split for qwen's array-element
//     collapse (duplicate keys inside one object).
//   R6 (truncated-envelope-tail): position-aware close of a token-limit-truncated
//     envelope — appends the unclosed array/root delimiters back to the last
//     completed element. Runs after R5 so a duplicate-key cluster is split first.
//   R0 (blanket-quote): blanket `<|"|>` → `"` catch-all, runs after R1.
//
// Provenance:
//   R0: google/gemma-4-26b-a4b on LM Studio
//     (~/src/kodr-testing/phase-111/gemma-smoke-2/.kodr/runs/2026-06-12T06-54-00.966Z/response.md)
//   R1: gemma role-B collapse observed in phase-113
//     (~/src/kodr-testing/phase-113/greenfield-logstats-1/.kodr/runs/2026-06-12T09-22-36.855Z/raw-response.json)
//   R2a: openai/gpt-oss-20b stray quote observed in phase-113
//     (~/src/kodr-testing/phase-113/transport-validation-gptoss/.kodr/runs/2026-06-12T11-41-44.327Z/raw-response.json)
//   R2b: openai/gpt-oss-20b missing brace observed in phase-114 (two runs)
//     (~/src/kodr-testing/phase-114/ab-gptoss-newprompt/.kodr/runs/2026-06-12T12-07-32.733Z/raw-response.json)
//     (~/src/kodr-testing/phase-114/ab2-gptoss/.kodr/runs/2026-06-12T12-25-15.658Z/raw-response.json)
//   R4: openai/gpt-oss-20b truncated envelope observed in phase-137
//     (~/src/kodr-testing/phase-137/gptoss-truncated-envelope.json, 975 bytes)
//   R6: qwen/qwen3.6-35b-a3b token-limit truncation observed 2026-06-15 (phase-147)
//     (~/src/kodr-testing/md-converter-qwen/.kodr/runs/2026-06-14T21-02-23.704Z/raw-response.json)

// Conservative JSON key charset: starts with letter or underscore, followed by
// alphanumerics or underscores. Never .* — avoids false positives in string values.
const JSON_KEY_RE = /[A-Za-z_][A-Za-z0-9_]*/u;

// Structural rules applied as regex replacements. These run BEFORE the blanket
// token rule to ensure proper ordering.
const STRUCTURAL_RULES = [
	{
		// R1: gemma collapsed-key artifact: "key:<|"|> → "key":"
		// The model collapses the colon-quote separator into the pseudo-token.
		ruleId: 'gemma-collapsed-key',
		pattern: new RegExp(`"(${JSON_KEY_RE.source}):<\\|"\\|>`, 'gu'),
		replacement: '"$1":"',
	},
	{
		// R2a: gpt-oss stray quote before array element boundary: },"{ → },{
		// The captured {  is preserved; the stray " before it is dropped.
		ruleId: 'gpt-oss-stray-quote',
		pattern: /\},"(\{)/gu,
		replacement: '},$1',
	},
	{
		// R2b: gpt-oss missing opening brace at array element boundary: },"key": → },{"key":
		// Must run AFTER R2a to avoid double-applying on },"{"key": patterns.
		ruleId: 'gpt-oss-missing-brace',
		pattern: new RegExp(`\\},"(${JSON_KEY_RE.source})"\\s*:`, 'gu'),
		replacement: '},{"$1":',
	},
];

// R3: gpt-oss unclosed-file-object repair rule.
//
// The gpt-oss truncated envelope: the file object's closing } is missing
// immediately before the files array ]. Shape:
//   "files":[{"path":"...","content":"..."  ]
//                                          ^ } MISSING here
//
// This rule is position-aware (like applyDuplicateKeyClusterRule) because a
// regex cannot safely determine brace balance. It scans for ] that would close
// an array while an object is still open inside it (top of nesting stack is {
// rather than the expected [), and inserts the missing }.
//
// Guards:
//   - Only fires when a { was opened and not closed inside the current array.
//   - Does not alter valid JSON (idempotent when no object is unclosed).
//   - Does not fire on arrays of non-objects like ["a","b"] (stack top would
//     be [ not {).
//
// Provenance: openai/gpt-oss-20b on LM Studio, phase-137 dogfood
//   (~/src/kodr-testing/phase-137/gptoss-truncated-envelope.json, 975 bytes)
//   summary.json: proposalFound:false, writeError: ProposalMissingError.
//   The raw wire failed JSON.parse at char 944; response.md rendering looked
//   valid (normalized rendering hid the truncation).
const UNCLOSED_FILE_OBJECT_RULE_ID = 'gpt-oss-unclosed-file-object';

function applyUnclosedFileObjectRule(text) {
	// Track opens as '{' or '['. When we encounter ] but the top of the stack
	// is '{' (an unclosed object), inject '}' to close it first.
	const stack = [];
	let result = '';
	let inString = false;
	let escaped = false;
	let fixCount = 0;

	for (let i = 0; i < text.length; i += 1) {
		const c = text[i];

		if (inString) {
			if (escaped) {
				escaped = false;
				result += c;
				continue;
			}
			if (c === '\\') {
				escaped = true;
				result += c;
				continue;
			}
			if (c === '"') {
				inString = false;
				result += c;
				continue;
			}
			result += c;
			continue;
		}

		if (c === '"') {
			inString = true;
			result += c;
			continue;
		}

		if (c === '{') {
			stack.push('{');
			result += c;
			continue;
		}

		if (c === '[') {
			stack.push('[');
			result += c;
			continue;
		}

		if (c === '}') {
			if (stack.length > 0 && stack[stack.length - 1] === '{') {
				stack.pop();
			}
			result += c;
			continue;
		}

		if (c === ']') {
			// If top of stack is '{', an object is unclosed inside this array.
			// Confirm there is a '[' beneath it (we are inside an array).
			if (
				stack.length >= 2 &&
				stack[stack.length - 1] === '{' &&
				stack[stack.length - 2] === '['
			) {
				result += '}'; // close the unclosed object
				stack.pop(); // pop the {
				fixCount += 1;
			}
			// Pop the [ that opened this array.
			if (stack.length > 0 && stack[stack.length - 1] === '[') {
				stack.pop();
			}
			result += c;
			continue;
		}

		result += c;
	}

	return { text: result, fixCount };
}

// R5: qwen duplicate-key-cluster split rule.
//
// The qwen array-element collapse: both files[] entries are emitted inside a
// single object literal with duplicate keys:
//   {"path":"a.mjs","content":...,"path":"b.mjs","content":...}
// This must become:
//   {"path":"a.mjs","content":...},{"path":"b.mjs","content":...}
//
// A naive regex cannot know object depth — `,"path":` may appear legitimately
// inside a string value or in a *different* object. The position-aware scanner
// below tracks string/escape state and object depth so it only splits when:
//   1. The repeat key appears at the SAME object depth (depth == 1 means we
//      are inside exactly one object, i.e. the potential array element).
//   2. The same key was already seen in the current object at this depth.
//   3. The key matches the conservative JSON_KEY_RE charset.
//
// Provenance: qwen/qwen3.6-35b-a3b on LM Studio, phase-117 validation run.
// Artifact: ~/src/kodr-testing/phase-117/greenfield-wordfreq-qwen/
//            .kodr/runs/2026-06-13T01-09-47.682Z/raw-response.json
// Decision: position-aware scan chosen over regex because object-depth tracking
//   is required to avoid false positives in string values or sibling objects.
//   (See process/decisions.jsonl phase 118 entry.)
const DUPLICATE_KEY_CLUSTER_RULE_ID = 'qwen-duplicate-key-cluster';

function applyDuplicateKeyClusterRule(text) {
	// Track per-depth key sets. Index = depth (1-based for outermost object).
	// Cleared on } that closes an object at that depth.
	const keySets = []; // keySets[depth-1] = Set of keys seen at that depth
	let depth = 0; // current object nesting depth (objects only; arrays transparent)
	let inString = false;
	let escaped = false;
	let result = '';
	let splitCount = 0;

	for (let i = 0; i < text.length; i += 1) {
		const char = text[i];

		if (inString) {
			if (escaped) {
				escaped = false;
				result += char;
				continue;
			}
			if (char === '\\') {
				escaped = true;
				result += char;
				continue;
			}
			if (char === '"') {
				inString = false;
				result += char;
				continue;
			}
			result += char;
			continue;
		}

		if (char === '"') {
			// Peek ahead: is this a key? A key is a quoted string followed by `:`.
			// Read the string content, then check the next non-whitespace char.
			let end = i + 1;
			let esc = false;
			while (end < text.length) {
				const c = text[end];
				if (esc) {
					esc = false;
				} else if (c === '\\') {
					esc = true;
				} else if (c === '"') {
					break;
				}
				end += 1;
			}
			const keyCandidate = text.slice(i + 1, end);
			// Find next non-whitespace after closing quote
			let next = end + 1;
			while (next < text.length && /\s/u.test(text[next])) {
				next += 1;
			}
			const isKey =
				text[next] === ':' &&
				depth > 0 &&
				JSON_KEY_RE.test(keyCandidate) &&
				// Ensure full match (no extra chars)
				keyCandidate === keyCandidate.match(JSON_KEY_RE)?.[0];

			if (isKey && depth > 0) {
				const keySet = keySets[depth - 1];
				if (keySet) {
					if (keySet.has(keyCandidate)) {
						// Duplicate key at this depth — inject },{ before this key.
						// Remove trailing comma/whitespace from result to avoid double comma.
						result = result.replace(/,\s*$/u, '');
						result += '},{';
						splitCount += 1;
						// Reset the key set for this new (split) object, seeding with the key.
						keySets[depth - 1] = new Set([keyCandidate]);
					} else {
						keySet.add(keyCandidate);
					}
				}
			}

			inString = true;
			result += char;
			continue;
		}

		if (char === '{') {
			depth += 1;
			if (keySets.length < depth) {
				keySets.push(new Set());
			} else {
				keySets[depth - 1] = new Set();
			}
			result += char;
			continue;
		}

		if (char === '}') {
			if (depth > 0) {
				keySets[depth - 1] = new Set();
				depth -= 1;
			}
			result += char;
			continue;
		}

		// Arrays don't affect object depth tracking.
		result += char;
	}

	return { text: result, splitCount };
}

// R6: truncated-envelope-tail close rule.
//
// A token-limit cutoff ends the stream mid-envelope: the root object and the
// files array are opened, the final file object is closed, but the array ] and
// root } are never emitted. A stray trailing token (qwen emits </parameter>)
// may follow the last }. Shape:
//   {"status":"OK",...,"files":[{...}{...}{...}{...}   <-- ] and } absent
// (the file objects may be a duplicate-key cluster — R5 splits that first.)
//
// This rule is position-aware (a regex cannot track brace balance). It walks
// the text tracking string/escape state and a stack of expected closers, and
// remembers lastSafeEnd: the index after the most recent container close that
// left the stack still open — i.e. the end of a completed element we can close
// back to. It stops at end-of-text or at the first structural-level garbage char
// while the stack is non-empty, and (only if a safe anchor exists) returns the
// prefix up to lastSafeEnd plus the still-open closers in innermost-first order.
//
// Guards:
//   - Fires only when the stack is still open at the stop point (genuine
//     truncation); idempotent on balanced JSON.
//   - Fires only when an element completed inside the open container
//     (lastSafeEnd > 0). A container truncated before any element completes has
//     no safe anchor and is left untouched — a half-written file is not a
//     produced file (phase-137 recover-or-reject discipline).
//   - Strings are opaque: a <, ] or } inside a string value never triggers.
//
// Provenance: qwen/qwen3.6-35b-a3b on LM Studio, 2026-06-15 examples-trial.
//   ~/src/kodr-testing/md-converter-qwen/.kodr/runs/2026-06-14T21-02-23.704Z/
//   raw-response.json (responses[-1].choices[0].message.content, 6763 chars).
//   summary.json: proposalFound:false, writeError: ProposalMissingError.
const TRUNCATED_ENVELOPE_RULE_ID = 'truncated-envelope-tail';

// Characters that may legally appear at the structural level as part of a bare
// literal (numbers, true/false/null). Anything else outside a string while a
// container is open is treated as the truncation/garbage tail.
const BARE_LITERAL_CHAR = /[A-Za-z0-9_+\-.]/u;

function applyTruncatedEnvelopeRule(text) {
	// Decode artifacts such as <|"|> introduce spurious string boundaries that
	// would make a complete envelope look truncated (the pseudo-token's inner "
	// closes a value string early, exposing | as structural-level garbage).
	// Normalize them before the structural scan so we measure real delimiters.
	// If the rule does NOT fire we return the ORIGINAL text so the blanket rule
	// can still count and replace the artifact downstream.
	const scan = applyBlanketRules(text).text;
	const stack = []; // expected closers in open order: '}' for {, ']' for [
	let inString = false;
	let escaped = false;
	let lastSafeEnd = -1;
	let lastSafeClosers = null;

	for (let i = 0; i < scan.length; i += 1) {
		const c = scan[i];

		if (inString) {
			if (escaped) {
				escaped = false;
			} else if (c === '\\') {
				escaped = true;
			} else if (c === '"') {
				inString = false;
			}
			continue;
		}

		if (c === '"') {
			inString = true;
			continue;
		}

		if (c === '{') {
			stack.push('}');
			continue;
		}

		if (c === '[') {
			stack.push(']');
			continue;
		}

		if (c === '}' || c === ']') {
			if (stack.length > 0) {
				stack.pop();
			}
			// A close that leaves the stack open marks a completed element we can
			// safely close back to. Snapshot the still-open closers here.
			if (stack.length > 0) {
				lastSafeEnd = i + 1;
				lastSafeClosers = [...stack].reverse().join('');
			}
			continue;
		}

		// Whitespace and structural punctuation between tokens are benign.
		if (
			c === ' ' ||
			c === '\t' ||
			c === '\r' ||
			c === '\n' ||
			c === ',' ||
			c === ':'
		) {
			continue;
		}

		// Bare-literal characters (numbers, true/false/null) are benign.
		if (BARE_LITERAL_CHAR.test(c)) {
			continue;
		}

		// Any other char at the structural level while a container is still open
		// is the truncation/garbage tail (e.g. '<' from a stray </parameter>).
		// Stop here so the garbage is dropped by the slice below.
		if (stack.length > 0) {
			break;
		}
	}

	// Fire only on genuine truncation (stack still open) with a safe anchor.
	// On fire we return the blanket-normalized prefix + closers (positions are
	// relative to `scan`); blanket re-application downstream is a no-op.
	if (stack.length > 0 && lastSafeEnd > 0 && lastSafeClosers) {
		return { text: scan.slice(0, lastSafeEnd) + lastSafeClosers, fixCount: 1 };
	}

	return { text, fixCount: 0 };
}

// Blanket token rules applied character-by-character (replaceAll).
const BLANKET_RULES = [
	{
		// R0: blanket <|"|> → " pseudo-token replacement (gemma phase-111+).
		ruleId: 'blanket-quote-token',
		from: '<|"|>',
		to: '"',
	},
];

// Combined ordered rule list (structural first, then blanket).
// Exported for tests so they can verify rule ordering and IDs.
export const DECODE_ARTIFACT_RULES = [
	...STRUCTURAL_RULES.map((r) => ({ ruleId: r.ruleId, type: 'structural' })),
	{ ruleId: UNCLOSED_FILE_OBJECT_RULE_ID, type: 'structural' },
	{ ruleId: DUPLICATE_KEY_CLUSTER_RULE_ID, type: 'structural' },
	{ ruleId: TRUNCATED_ENVELOPE_RULE_ID, type: 'structural' },
	...BLANKET_RULES.map((r) => ({ ruleId: r.ruleId, type: 'blanket' })),
];

// Apply structural rules (regex-based + position-aware) and return {text, repairs}.
// Structural rules MUST only run in the repair path — they risk corrupting
// valid string values that happen to contain the pattern.
function applyStructuralRules(text) {
	let result = text;
	const repairs = [];
	for (const rule of STRUCTURAL_RULES) {
		const matches = [...result.matchAll(rule.pattern)];
		if (matches.length > 0) {
			repairs.push({ ruleId: rule.ruleId, count: matches.length });
			result = result.replace(rule.pattern, rule.replacement);
		}
	}
	// R4: position-aware unclosed-file-object repair (gpt-oss truncated envelope).
	// Applied after R2a/R2b so those boundary patterns are handled first.
	// Applied before R5 (duplicate-key-cluster) since both are position-aware;
	// unclosed-object repair is safer to run first (structural completeness).
	const { text: unclosedText, fixCount: unclosedCount } =
		applyUnclosedFileObjectRule(result);
	if (unclosedCount > 0) {
		repairs.push({
			ruleId: UNCLOSED_FILE_OBJECT_RULE_ID,
			count: unclosedCount,
		});
		result = unclosedText;
	}
	// R5: position-aware duplicate-key-cluster split (qwen array-element collapse).
	// Applied after regex rules so R2a/R2b handle gpt-oss patterns first.
	const { text: splitText, splitCount } = applyDuplicateKeyClusterRule(result);
	if (splitCount > 0) {
		repairs.push({ ruleId: DUPLICATE_KEY_CLUSTER_RULE_ID, count: splitCount });
		result = splitText;
	}
	// R6: position-aware truncated-envelope-tail close (qwen token-limit cutoff).
	// Applied LAST so a duplicate-key cluster (R5) is split into separate objects
	// before the unclosed array/root are closed back to the last completed element.
	const { text: closedText, fixCount: truncatedCount } =
		applyTruncatedEnvelopeRule(result);
	if (truncatedCount > 0) {
		repairs.push({ ruleId: TRUNCATED_ENVELOPE_RULE_ID, count: truncatedCount });
		result = closedText;
	}
	return { text: result, repairs };
}

// Apply blanket token rules and return {text, repairs}.
function applyBlanketRules(text) {
	let result = text;
	const repairs = [];
	for (const rule of BLANKET_RULES) {
		// Count occurrences in the current result (before replacing).
		const count = result.split(rule.from).length - 1;
		if (count > 0) {
			result = result.replaceAll(rule.from, rule.to);
			repairs.push({ ruleId: rule.ruleId, count });
		}
	}
	return { text: result, repairs };
}

// repairJsonText applies rules in two modes:
//   - repairOnly=false (default): only applies blanket rules (safe, unconditional)
//   - repairOnly=true: applies structural rules first, then blanket rules
// Returns {text, repairs} where repairs is an array of {ruleId, count} entries.
function repairJsonText(text, { structural = false } = {}) {
	let allRepairs = [];
	let result = text;

	if (structural) {
		const { text: t, repairs } = applyStructuralRules(result);
		result = t;
		allRepairs = allRepairs.concat(repairs);
	}

	const { text: t2, repairs: blanketRepairs } = applyBlanketRules(result);
	result = t2;
	allRepairs = allRepairs.concat(blanketRepairs);

	return {
		text: repairRawStringControlChars(result).replaceAll('\\`', '`'),
		repairs: allRepairs,
	};
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
