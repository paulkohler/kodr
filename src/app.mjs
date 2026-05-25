import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

export const VERSION = '0.0.0';

const DEFAULT_BASE_URL = 'http://localhost:1234/v1';
const DEFAULT_TIMEOUT_MS = 600000;
const PROBE_PROMPT = 'Reply with exactly: koder-probe-ok';

export class CliError extends Error {
	constructor(message) {
		super(message);
		this.name = 'CliError';
	}
}

export function parseArgs(argv, env = {}) {
	const options = {
		baseUrl: env.BASE_URL || DEFAULT_BASE_URL,
		command: 'help',
		help: false,
		json: false,
		model: env.MODEL_ID || '',
		apiKey: env.OPENAI_API_KEY || '',
		timeoutMs: DEFAULT_TIMEOUT_MS,
		version: false,
	};

	const positionals = [];

	for (let index = 0; index < argv.length; index += 1) {
		const arg = argv[index];

		if (arg === '-h' || arg === '--help') {
			options.help = true;
			continue;
		}

		if (arg === '--version') {
			options.version = true;
			continue;
		}

		if (arg === '--json') {
			options.json = true;
			continue;
		}

		if (
			arg === '--base-url' ||
			arg === '--model' ||
			arg === '--api-key' ||
			arg === '--timeout-ms'
		) {
			const value = argv[index + 1];
			if (!value || value.startsWith('--')) {
				throw new CliError(`${arg} requires a value`);
			}
			index += 1;
			assignValue(options, arg, value);
			continue;
		}

		if (arg.startsWith('--')) {
			throw new CliError(`Unknown option: ${arg}`);
		}

		positionals.push(arg);
	}

	if (positionals.length > 0) {
		options.command = positionals[0];
		if (positionals.length > 1) {
			throw new CliError(
				`Unexpected positional arguments: ${positionals.slice(1).join(' ')}`,
			);
		}
	}

	if (!Number.isInteger(options.timeoutMs) || options.timeoutMs < 100) {
		throw new CliError(
			'--timeout-ms must be an integer greater than or equal to 100',
		);
	}

	return options;
}

export function usage() {
	return `koder ${VERSION}

Usage:
  koder --help
  koder --version
  koder probe [--json]

Local-model defaults:
  --base-url URL       Default: ${DEFAULT_BASE_URL}
  --model ID           Default: MODEL_ID
  --api-key KEY        Default: OPENAI_API_KEY
  --timeout-ms N       Default: ${DEFAULT_TIMEOUT_MS}

The first build phases will add:
  koder run -p "task"
  koder run --workflow
`;
}

export async function main(argv, io) {
	const options = parseArgs(argv, io.env);

	if (options.version) {
		io.stdout.write(`${VERSION}\n`);
		return { ok: true, command: 'version' };
	}

	if (options.help || options.command === 'help') {
		io.stdout.write(usage());
		return { ok: true, command: 'help' };
	}

	if (options.command === 'probe') {
		const result = await probe(options, io);
		if (options.json) {
			io.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
		} else {
			io.stdout.write(`Probe ok\n`);
			io.stdout.write(`Run: ${result.runDir}\n`);
			io.stdout.write(`Model: ${result.model}\n`);
			io.stdout.write(`Reply: ${result.reply}\n`);
		}
		return { ok: true, command: 'probe', result };
	}

	throw new CliError(`Command not implemented yet: ${options.command}`);
}

function assignValue(options, flag, value) {
	if (flag === '--base-url') {
		options.baseUrl = value.replace(/\/+$/u, '');
	} else if (flag === '--model') {
		options.model = value;
	} else if (flag === '--api-key') {
		options.apiKey = value;
	} else if (flag === '--timeout-ms') {
		options.timeoutMs = Number(value);
	}
}

async function probe(options, io) {
	const runDir = join(io.cwd, '.koder', 'runs', timestamp());
	await mkdir(runDir, { recursive: true });

	const modelsUrl = `${options.baseUrl}/models`;
	const modelsResponse = await requestJson(modelsUrl, {
		apiKey: options.apiKey,
		method: 'GET',
		timeoutMs: options.timeoutMs,
	});

	await writeJson(join(runDir, 'models-response.json'), modelsResponse);

	const model = options.model || firstModelId(modelsResponse.body);
	if (!model) {
		throw new CliError(
			'No model was provided and GET /models did not return a usable model id',
		);
	}

	const chatBody = {
		messages: [
			{
				content: PROBE_PROMPT,
				role: 'user',
			},
		],
		model,
		temperature: 0,
	};

	await writeJson(join(runDir, 'chat-request.json'), {
		body: chatBody,
		url: `${options.baseUrl}/chat/completions`,
	});

	const chatResponse = await requestJson(
		`${options.baseUrl}/chat/completions`,
		{
			apiKey: options.apiKey,
			body: chatBody,
			method: 'POST',
			timeoutMs: options.timeoutMs,
		},
	);

	await writeJson(join(runDir, 'chat-response.json'), chatResponse);

	const reply = firstAssistantMessage(chatResponse.body);
	if (!reply) {
		throw new CliError(
			'POST /chat/completions did not return a usable assistant message',
		);
	}

	const result = {
		baseUrl: options.baseUrl,
		model,
		ok: true,
		reply,
		runDir,
	};

	await writeJson(join(runDir, 'result.json'), result);
	return result;
}

async function requestJson(url, options) {
	const headers = {
		accept: 'application/json',
	};

	if (options.body) {
		headers['content-type'] = 'application/json';
	}

	if (options.apiKey) {
		headers.authorization = `Bearer ${options.apiKey}`;
	}

	let response;
	try {
		response = await fetch(url, {
			body: options.body ? JSON.stringify(options.body) : undefined,
			headers,
			method: options.method,
			signal: AbortSignal.timeout(options.timeoutMs),
		});
	} catch (error) {
		throw new CliError(`${options.method} ${url} failed: ${error.message}`);
	}

	const text = await response.text();
	const parsed = parseJson(text, `${options.method} ${url}`);

	if (!response.ok) {
		throw new CliError(
			`${options.method} ${url} returned HTTP ${response.status}`,
		);
	}

	return {
		body: parsed,
		status: response.status,
		url,
	};
}

function parseJson(text, label) {
	try {
		return JSON.parse(text);
	} catch {
		throw new CliError(`${label} returned invalid JSON`);
	}
}

function firstModelId(body) {
	if (!body || !Array.isArray(body.data)) {
		return '';
	}

	const model = body.data.find(
		(item) => item && typeof item.id === 'string' && item.id.length > 0,
	);
	return model ? model.id : '';
}

function firstAssistantMessage(body) {
	const content = body?.choices?.[0]?.message?.content;
	return typeof content === 'string' ? content : '';
}

async function writeJson(path, value) {
	await writeFile(path, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
}

function timestamp() {
	return new Date().toISOString().replaceAll(':', '-');
}
