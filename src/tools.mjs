import { lookup } from 'node:dns/promises';
import { readFile } from 'node:fs/promises';
import { request as httpRequest } from 'node:http';
import { request as httpsRequest } from 'node:https';
import { BlockList, isIP } from 'node:net';
import { Readable } from 'node:stream';
import { listContextFiles } from './context-packer.mjs';
import { createHooks, HookBlockedError } from './hooks.mjs';
import {
	createPermissionPolicy,
	PermissionPolicyError,
} from './permission-policy.mjs';
import { jailedPath, prepareWrites } from './safe-writes.mjs';
import { createTaskPlan, updateTask } from './task-plan.mjs';
import { runVerification } from './verification-runner.mjs';

const DEFAULT_FETCH_TIMEOUT_MS = 10000;
const DEFAULT_FETCH_MAX_BYTES = 20000;

const BLOCKED_NETWORKS = new BlockList();
for (const [network, prefix, family] of [
	['0.0.0.0', 8, 'ipv4'],
	['10.0.0.0', 8, 'ipv4'],
	['100.64.0.0', 10, 'ipv4'],
	['127.0.0.0', 8, 'ipv4'],
	['169.254.0.0', 16, 'ipv4'],
	['172.16.0.0', 12, 'ipv4'],
	['192.0.0.0', 24, 'ipv4'],
	['192.168.0.0', 16, 'ipv4'],
	['198.18.0.0', 15, 'ipv4'],
	['224.0.0.0', 4, 'ipv4'],
	['240.0.0.0', 4, 'ipv4'],
	['::', 128, 'ipv6'],
	['::1', 128, 'ipv6'],
	['fc00::', 7, 'ipv6'],
	['fe80::', 10, 'ipv6'],
	['ff00::', 8, 'ipv6'],
]) {
	BLOCKED_NETWORKS.addSubnet(network, prefix, family);
}

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
		this.taskPlan = options.taskPlan || createTaskPlan(options.task || '');
		this.hooks = createHooks(options.hooks);
		this.policy = createPermissionPolicy(options.policy);
		// Lazy MCP (phase 149): mcp-client.mjs is imported only when an MCP tool
		// is actually called, so a bare run never loads it. Providers are kept
		// here; the client is built on first use via getMcp().
		this.mcpProviders = options.mcpProviders || options.mcp || [];
		this.mcp = null;
		this.commandRunner = options.commandRunner || null;
		this.permissionApprover = options.permissionApprover || null;
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
		const hookDecisions = [];
		let activeInput = input;

		try {
			const pre = await this.hooks.run('pre_tool_use', {
				cwd: this.cwd,
				input: activeInput,
				tool: name,
			});
			hookDecisions.push(...pre.decisions);
			activeInput = pre.payload.input;
		} catch (error) {
			if (error instanceof HookBlockedError) {
				throw new ToolError(error.message);
			}
			throw error;
		}

		const result = await this.runTool(name, activeInput);
		const post = await this.hooks.run('post_tool_use', {
			cwd: this.cwd,
			input: activeInput,
			result,
			tool: name,
		});
		hookDecisions.push(...post.decisions);

		return post.payload.result;
	}

	async getMcp() {
		if (!this.mcp) {
			const { createMcpClient } = await import('./mcp-client.mjs');
			this.mcp = createMcpClient(this.mcpProviders);
		}
		return this.mcp;
	}

	async runTool(name, input = {}) {
		if (name.startsWith('mcp:')) {
			return (await this.getMcp()).callTool(name, input);
		}

		if (name === 'list_mcp_tools') {
			return (await this.getMcp()).listTools();
		}

		if (name === 'list_files') {
			return listContextFiles(this.cwd);
		}

		if (name === 'read_file') {
			await this.checkPermission('read_file', { path: input.path }, () =>
				this.policy.checkRead(input.path),
			);
			const jailed = await jailedPath(this.cwd, input.path);
			return readFile(jailed.absolute, 'utf8');
		}

		if (name === 'write_file') {
			await this.checkPermission(
				'write_file',
				{ apply: input.apply === true, path: input.path },
				() =>
					this.policy.checkWrite(input.path, { apply: input.apply === true }),
			);
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
			await this.checkPermission(
				'run_command',
				{ command: input.command },
				() => this.policy.checkCommand(input.command),
			);
			return runVerification(this.cwd, input.command, {
				runner: this.commandRunner,
				timeoutMs: input.timeoutMs,
			});
		}

		if (name === 'fetch_url') {
			await this.checkPermission('fetch_url', { url: input.url }, () =>
				this.policy.checkNetwork(input.url),
			);
			return fetchUrl(input.url, {
				maxBytes: input.maxBytes,
				timeoutMs: input.timeoutMs,
			});
		}

		if (name === 'list_tasks') {
			return this.taskPlan;
		}

		if (name === 'update_task') {
			this.taskPlan = updateTask(
				this.taskPlan,
				input.id,
				input.status,
				input.note || '',
			);
			return this.taskPlan;
		}

		throw new ToolError(`Unknown tool: ${name}`);
	}

	async checkPermission(action, input, check) {
		try {
			check();
			return;
		} catch (error) {
			if (!(error instanceof PermissionPolicyError)) {
				throw error;
			}
			if (!this.permissionApprover) {
				throw error;
			}
			const request = createPermissionRequest(action, input, error.message);
			const decision = await this.permissionApprover(request);
			if (decision?.decision === 'allow') {
				return;
			}
			throw new ToolError(
				`Permission denied for ${action}: ${decision?.reason || error.message}`,
			);
		}
	}
}

export function createPermissionRequest(action, input, reason) {
	return {
		action,
		input,
		reason,
		status: 'pending',
	};
}

export async function fetchUrl(url, options = {}) {
	const parsed = new URL(url);
	if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
		throw new ToolError(`Unsupported URL protocol: ${parsed.protocol}`);
	}

	if (parsed.username || parsed.password) {
		throw new ToolError('URL credentials are not allowed');
	}

	if (isBlockedHost(parsed.hostname)) {
		throw new ToolError(`Blocked local or private URL: ${url}`);
	}

	const target = await resolvePublicTarget(
		parsed.hostname,
		url,
		options.lookupHost,
	);

	const timeoutMs = options.timeoutMs || DEFAULT_FETCH_TIMEOUT_MS;
	const maxBytes = options.maxBytes || DEFAULT_FETCH_MAX_BYTES;
	// Security: never follow redirects. The host checks above only validate the
	// URL we were given; a redirect could send us to a private address (e.g. a
	// cloud metadata endpoint) that was never validated. Reject 3xx outright.
	const response = options.fetchImpl
		? await options.fetchImpl(url, {
				redirect: 'manual',
				signal: AbortSignal.timeout(timeoutMs),
			})
		: await (options.requestImpl || requestPinned)(parsed, target, timeoutMs);
	if (response.status >= 300 && response.status < 400) {
		throw new ToolError(`Refusing to follow redirect from ${url}`);
	}
	return {
		body: await readCappedText(response, maxBytes),
		status: response.status,
		url,
	};
}

function isBlockedHost(hostname) {
	const lower = stripAddressBrackets(hostname).toLowerCase();
	if (lower === 'localhost' || lower.endsWith('.localhost')) {
		return true;
	}

	return isIP(lower) !== 0 && isBlockedAddress(lower);
}

async function resolvePublicTarget(hostname, url, lookupHost = lookup) {
	const normalizedHost = stripAddressBrackets(hostname);
	const literalFamily = isIP(normalizedHost);
	if (literalFamily) {
		if (isBlockedAddress(normalizedHost)) {
			throw new ToolError(`Blocked local or private URL: ${url}`);
		}
		return { address: normalizedHost, family: literalFamily };
	}

	const addresses = await lookupHost(normalizedHost, {
		all: true,
		verbatim: true,
	});
	if (!Array.isArray(addresses) || addresses.length === 0) {
		throw new ToolError(`URL host did not resolve: ${url}`);
	}

	for (const address of addresses) {
		if (isBlockedAddress(address.address)) {
			throw new ToolError(`Blocked local or private URL: ${url}`);
		}
	}
	const selected = addresses[0];
	return {
		address: stripAddressBrackets(selected.address),
		family: selected.family || isIP(stripAddressBrackets(selected.address)),
	};
}

function isBlockedAddress(address) {
	const normalized = stripAddressBrackets(address).toLowerCase();
	const family = isIP(normalized);
	if (!family) {
		return true;
	}
	// Do not allow IPv4-mapped IPv6 literals. Treating these as ordinary IPv6
	// can bypass IPv4 private-range checks, while accepting them provides no
	// useful capability that a normal IPv4 literal does not already cover.
	if (family === 6 && normalized.startsWith('::ffff:')) {
		return true;
	}
	return BLOCKED_NETWORKS.check(normalized, family === 4 ? 'ipv4' : 'ipv6');
}

function stripAddressBrackets(value) {
	return value.replace(/^\[|\]$/gu, '');
}

function requestPinned(url, target, timeoutMs) {
	return new Promise((resolve, reject) => {
		const transport = url.protocol === 'https:' ? httpsRequest : httpRequest;
		const request = transport(
			{
				headers: { accept: '*/*' },
				hostname: stripAddressBrackets(url.hostname),
				lookup(_hostname, lookupOptions, callback) {
					if (lookupOptions?.all) {
						callback(null, [target]);
						return;
					}
					callback(null, target.address, target.family);
				},
				method: 'GET',
				path: `${url.pathname}${url.search}`,
				port: url.port || undefined,
				protocol: url.protocol,
				signal: AbortSignal.timeout(timeoutMs),
			},
			(incoming) => {
				resolve({
					body: Readable.toWeb(incoming),
					status: incoming.statusCode || 0,
				});
			},
		);
		request.on('error', reject);
		request.end();
	});
}

async function readCappedText(response, maxBytes) {
	const reader = response.body?.getReader();
	if (!reader) {
		return '';
	}

	const chunks = [];
	let used = 0;

	while (true) {
		const { done, value } = await reader.read();
		if (done) {
			return Buffer.concat(chunks).toString('utf8');
		}

		const bytesLeft = maxBytes - used;
		if (bytesLeft <= 0) {
			await reader.cancel();
			throw new ToolError(`fetch_url response exceeded ${maxBytes} bytes`);
		}

		const chunk = Buffer.from(value);
		if (chunk.length > bytesLeft) {
			chunks.push(chunk.subarray(0, bytesLeft));
			await reader.cancel();
			throw new ToolError(`fetch_url response exceeded ${maxBytes} bytes`);
		}

		chunks.push(chunk);
		used += chunk.length;
	}
}
