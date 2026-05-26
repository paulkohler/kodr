import { mkdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { writeJson } from './artifacts.mjs';

const USER_DIRECTION_PATTERNS = [
	/\bdo not\b/iu,
	/\bdon't\b/iu,
	/\bmake sure\b/iu,
	/\bremember\b/iu,
	/\bi want\b/iu,
	/\bwe should\b/iu,
	/\bshould we\b/iu,
	/\blet'?s\b/iu,
	/\bbefore\b/iu,
	/\bafter\b/iu,
	/\buse\b/iu,
];

export async function runSubagent(cwd, runDir, request) {
	if (request.kind !== 'cycle-review') {
		throw new SubagentError(`Unknown subagent kind: ${request.kind}`);
	}

	const agentDir = join(runDir, 'subagents', request.id);
	await mkdir(agentDir, { recursive: true });
	await writeJson(join(agentDir, 'request.json'), request);

	const result = await runCycleReview(cwd, request);
	await writeJson(join(agentDir, 'result.json'), result);
	return {
		artifactDir: agentDir,
		request,
		result,
	};
}

export function createCycleReviewRequest(options) {
	return {
		id: options.id || 'cycle-review',
		input: {
			agentsPath: options.agentsPath || 'AGENTS.md',
			transcript: options.transcript,
			transcriptPath: options.transcriptPath,
		},
		kind: 'cycle-review',
	};
}

export class SubagentError extends Error {
	constructor(message) {
		super(message);
		this.name = 'SubagentError';
	}
}

async function runCycleReview(cwd, request) {
	const agentsPath = request.input.agentsPath;
	const agents = await readOptionalText(join(cwd, agentsPath));
	const directions = extractUserDirections(request.input.transcript);
	const missingDirections = directions.filter((direction) => {
		return !containsDirection(agents, direction.text);
	});

	return {
		agentsPath,
		findings: missingDirections.map((direction) => {
			return {
				askUser:
					'Ask whether this direction should be added to AGENTS.md before relying on chat history.',
				evidence: direction.text,
				severity: direction.severity,
				suggestedAgentNote: suggestedAgentNote(direction.text),
			};
		}),
		ok: true,
		reviewed: {
			agentsPresent: agents !== '',
			directionCount: directions.length,
			missingDirectionCount: missingDirections.length,
			transcriptPath: request.input.transcriptPath,
		},
	};
}

function extractUserDirections(transcript) {
	return transcript
		.split('\n')
		.map((line) => line.trim())
		.filter(Boolean)
		.filter(
			(line) =>
				isUserLine(line) ||
				USER_DIRECTION_PATTERNS.some((pattern) => pattern.test(line)),
		)
		.map(stripSpeaker)
		.filter((line) => line.length >= 12)
		.filter((line) =>
			USER_DIRECTION_PATTERNS.some((pattern) => pattern.test(line)),
		)
		.map((text) => {
			return {
				severity: directionSeverity(text),
				text,
			};
		});
}

function isUserLine(line) {
	return /^(user|human|paul)\s*:/iu.test(line);
}

function stripSpeaker(line) {
	return line.replace(/^(user|human|paul)\s*:\s*/iu, '').trim();
}

function containsDirection(agents, direction) {
	const haystack = normalizeText(agents);
	const needle = normalizeText(direction);
	const tokens = needle
		.split(' ')
		.filter((token) => token.length > 3)
		.filter((token) => !COMMON_WORDS.has(token));

	if (tokens.length === 0) {
		return false;
	}

	const matches = tokens.filter((token) => haystack.includes(token));
	return matches.length / tokens.length >= 0.6;
}

function suggestedAgentNote(direction) {
	return `Consider whether to add this process rule: ${direction}`;
}

function directionSeverity(text) {
	return /\b(do not|don't|make sure|must|always|before|after)\b/iu.test(text)
		? 'high'
		: 'medium';
}

function normalizeText(value) {
	return value
		.toLowerCase()
		.replaceAll(/[^a-z0-9]+/gu, ' ')
		.trim();
}

async function readOptionalText(path) {
	try {
		return await readFile(path, 'utf8');
	} catch (error) {
		if (error.code === 'ENOENT') {
			return '';
		}
		throw error;
	}
}

const COMMON_WORDS = new Set([
	'about',
	'after',
	'before',
	'could',
	'from',
	'have',
	'into',
	'make',
	'moving',
	'sure',
	'that',
	'this',
	'what',
	'when',
	'with',
	'would',
]);
