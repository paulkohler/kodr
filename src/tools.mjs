import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { listContextFiles } from './context-packer.mjs';
import { prepareWrites } from './safe-writes.mjs';
import { runVerification } from './verification-runner.mjs';

export class ToolError extends Error {
	constructor(message) {
		super(message);
		this.name = 'ToolError';
	}
}

export class ToolRunner {
	constructor(cwd, options = {}) {
		this.cwd = cwd;
		this.remainingCalls = options.maxCalls || 20;
		this.seen = new Set();
	}

	async call(name, input = {}) {
		const key = `${name}:${JSON.stringify(input)}`;
		if (this.seen.has(key)) {
			throw new ToolError(`Duplicate tool call stopped: ${name}`);
		}

		if (this.remainingCalls <= 0) {
			throw new ToolError('Tool budget exhausted');
		}

		this.seen.add(key);
		this.remainingCalls -= 1;

		if (name === 'list_files') {
			return listContextFiles(this.cwd);
		}

		if (name === 'read_file') {
			return readFile(join(this.cwd, input.path), 'utf8');
		}

		if (name === 'write_file') {
			return prepareWrites(
				this.cwd,
				[
					{
						content: input.content,
						path: input.path,
					},
				],
				{ apply: input.apply === true },
			);
		}

		if (name === 'run_command') {
			return runVerification(this.cwd, input.command, {
				timeoutMs: input.timeoutMs,
			});
		}

		if (name === 'fetch_url') {
			return fetchUrl(input.url);
		}

		throw new ToolError(`Unknown tool: ${name}`);
	}
}

async function fetchUrl(url) {
	const parsed = new URL(url);
	if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
		throw new ToolError(`Unsupported URL protocol: ${parsed.protocol}`);
	}

	if (isBlockedHost(parsed.hostname)) {
		throw new ToolError(`Blocked local or private URL: ${url}`);
	}

	const response = await fetch(url);
	return {
		body: await response.text(),
		status: response.status,
		url,
	};
}

function isBlockedHost(hostname) {
	const lower = hostname.toLowerCase();
	if (lower === 'localhost' || lower.endsWith('.localhost')) {
		return true;
	}

	if (lower === '127.0.0.1' || lower === '0.0.0.0' || lower === '::1') {
		return true;
	}

	if (/^10\./u.test(lower) || /^192\.168\./u.test(lower)) {
		return true;
	}

	const match = /^172\.(\d+)\./u.exec(lower);
	if (match) {
		const second = Number(match[1]);
		return second >= 16 && second <= 31;
	}

	return false;
}
