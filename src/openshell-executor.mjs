import { spawn } from 'node:child_process';
import {
	cp,
	lstat,
	mkdir,
	readdir,
	readlink,
	realpath,
	rm,
	writeFile,
} from 'node:fs/promises';
import { basename, isAbsolute, join, relative, resolve } from 'node:path';

const DEFAULT_WORKDIR = '/sandbox';
const SAFE_NAME = /[^a-zA-Z0-9_.-]+/gu;
const SNAPSHOT_DIR = 'openshell-upload';
const DEFAULT_POLICY_FILE = 'openshell-default-deny.yaml';
const EXCLUDED_NAMES = new Set([
	'.git',
	'.kodr',
	'node_modules',
	'KODR_MEMORY.md',
]);

export class OpenShellSandboxError extends Error {
	constructor(message, details = {}) {
		super(message);
		this.name = 'OpenShellSandboxError';
		this.details = details;
	}
}

export function openshellDefaults(options = {}) {
	return {
		openshellFrom: options.openshellFrom || '',
		openshellKeep: options.openshellKeep === true,
		openshellPolicy: options.openshellPolicy || '',
	};
}

export function validateOpenShellOptions(options = {}) {
	if (!options.openshellSandbox) {
		return;
	}
	if (options.dockerSandbox) {
		throw new OpenShellSandboxError(
			'--docker-sandbox and --openshell-sandbox cannot be used together',
		);
	}
	if (options.installDependencies && !options.openshellPolicy) {
		throw new OpenShellSandboxError(
			'--install with --openshell-sandbox requires --openshell-policy so dependency network access is explicit',
		);
	}
}

export function createOpenShellExecutor(hostCwd, runDir, options = {}) {
	if (!options.openshellSandbox) {
		return null;
	}
	return new OpenShellExecutor(hostCwd, runDir, options);
}

export class OpenShellExecutor {
	constructor(hostCwd, runDir, options = {}) {
		const defaults = openshellDefaults(options);
		this.backend = 'openshell';
		this.hostCwd = hostCwd;
		this.runDir = runDir;
		this.from = defaults.openshellFrom;
		this.keep = defaults.openshellKeep;
		this.policyOption = defaults.openshellPolicy;
		this.policyPath = '';
		this.runner = options.openshellRunner || spawnOpenShell;
		this.sandboxId = `kodr-${safeName(basename(runDir || 'run'))}`;
		this.snapshotDir = join(runDir, SNAPSHOT_DIR);
		this.workdir = DEFAULT_WORKDIR;
		this.commands = [];
		this.gateway = { endpoint: '', local: false };
		this.available = false;
		this.initialized = false;
		this.finalized = false;
		this.error = null;
		this.syncCount = 0;
	}

	async initialize(timeoutMs = 60000) {
		if (this.initialized) {
			return;
		}
		try {
			await this.probe(timeoutMs);
			this.policyPath = await this.resolvePolicy();
			const args = [
				'sandbox',
				'create',
				'--name',
				this.sandboxId,
				'--no-bootstrap',
				'--no-tty',
			];
			if (this.from) {
				args.push('--from', this.from);
			}
			args.push('--policy', this.policyPath, '--', '/bin/true');
			const result = await this.runner(args, timeoutMs);
			if (result.exitCode !== 0 || result.timedOut) {
				throw commandError('Could not create OpenShell sandbox', args, result);
			}
			this.initialized = true;
			await this.syncWorkspace(timeoutMs);
		} catch (error) {
			this.error = serializeError(error);
			throw error;
		}
	}

	async probe(timeoutMs = 60000) {
		const version = await this.runner(['--version'], timeoutMs);
		if (version.exitCode !== 0 || version.timedOut) {
			throw new OpenShellSandboxError(
				'OpenShell CLI is unavailable. Install a compatible openshell CLI or remove --openshell-sandbox.',
				{ stderr: version.stderr, stdout: version.stdout },
			);
		}

		for (const command of ['create', 'exec', 'upload', 'delete']) {
			const args = ['sandbox', command, '--help'];
			const result = await this.runner(args, timeoutMs);
			if (result.exitCode !== 0 || result.timedOut) {
				throw new OpenShellSandboxError(
					`OpenShell CLI is incompatible: missing "sandbox ${command}". Upgrade OpenShell or remove --openshell-sandbox.`,
					{
						command: args.join(' '),
						stderr: result.stderr,
						stdout: result.stdout,
					},
				);
			}
		}

		const status = await this.runner(['status'], timeoutMs);
		if (status.exitCode !== 0 || status.timedOut) {
			throw new OpenShellSandboxError(
				'OpenShell local gateway is not running. Start or select a local gateway before using --openshell-sandbox.',
				{ stderr: status.stderr, stdout: status.stdout },
			);
		}
		const endpoint = extractGatewayEndpoint(
			`${status.stdout}\n${status.stderr}`,
		);
		if (!endpoint || !isLocalGateway(endpoint)) {
			throw new OpenShellSandboxError(
				'OpenShell sandboxing currently requires a selected local loopback gateway; remote gateways are not supported.',
				{ endpoint },
			);
		}
		this.available = true;
		this.gateway = { endpoint, local: true };
	}

	async run(_cwd, parsed, timeoutMs) {
		await this.initialize(timeoutMs);
		await this.syncWorkspace(timeoutMs);
		const args = this.execArgs(parsed, timeoutMs);
		const command = `${parsed.bin} ${parsed.args.join(' ')}`.trim();
		const startedAt = new Date().toISOString();
		const started = performance.now();
		const result = await this.runner(args, timeoutMs);
		const record = {
			command,
			durationMs: Math.round(performance.now() - started),
			exitCode: result.exitCode,
			finishedAt: new Date().toISOString(),
			sandboxId: this.sandboxId,
			startedAt,
			timedOut: result.timedOut,
		};
		this.commands.push(record);
		return {
			...result,
			execution: {
				environment: 'openshell',
				...record,
			},
		};
	}

	hookExecutor() {
		return {
			environment: 'openshell',
			runHook: async (_cwd, hook, input, timeoutMs) => {
				await this.initialize(timeoutMs);
				await this.syncWorkspace(timeoutMs);
				return this.runner(
					this.execArgs(
						{ args: (hook.args || []).map(String), bin: hook.command },
						timeoutMs,
					),
					timeoutMs,
					input,
				);
			},
		};
	}

	async syncWorkspace(timeoutMs = 60000) {
		if (!this.initialized) {
			return;
		}
		await buildWorkspaceSnapshot(this.hostCwd, this.snapshotDir, {
			excludePaths: [this.runDir],
		});
		const entries = await readdir(this.snapshotDir, { withFileTypes: true });
		for (const entry of entries) {
			const localPath = join(this.snapshotDir, entry.name);
			const destination = `${this.workdir}/${entry.name}`;
			const args = [
				'sandbox',
				'upload',
				'--no-git-ignore',
				this.sandboxId,
				localPath,
				destination,
			];
			const result = await this.runner(args, timeoutMs);
			if (result.exitCode !== 0 || result.timedOut) {
				throw commandError(
					'Could not upload workspace to OpenShell',
					args,
					result,
				);
			}
		}
		this.syncCount += 1;
	}

	async finalize(timeoutMs = 60000) {
		if (this.finalized || !this.initialized || this.keep) {
			this.finalized = true;
			return;
		}
		const args = ['sandbox', 'delete', this.sandboxId];
		const result = await this.runner(args, timeoutMs);
		this.finalized = true;
		if (result.exitCode !== 0 || result.timedOut) {
			const error = commandError(
				'Could not delete OpenShell sandbox',
				args,
				result,
			);
			this.error = serializeError(error);
			throw error;
		}
	}

	metadata() {
		return {
			available: this.available,
			backend: 'openshell',
			commands: this.commands,
			enabled: true,
			error: this.error,
			from: this.from,
			gateway: this.gateway,
			initialized: this.initialized,
			kept: this.keep,
			policy: {
				network: this.policyOption ? 'explicit-policy' : 'default-deny',
				path: this.policyPath || this.policyOption,
			},
			sandboxId: this.sandboxId,
			syncCount: this.syncCount,
			workspaceSync: {
				host: this.hostCwd,
				sandbox: this.workdir,
				writeback: false,
			},
		};
	}

	execArgs(parsed, timeoutMs) {
		return [
			'sandbox',
			'exec',
			'-n',
			this.sandboxId,
			'--workdir',
			this.workdir,
			'--timeout',
			String(Math.max(1, Math.ceil(timeoutMs / 1000))),
			'--no-tty',
			'--',
			parsed.bin,
			...parsed.args,
		];
	}

	async resolvePolicy() {
		if (this.policyOption) {
			const absolute = isAbsolute(this.policyOption)
				? this.policyOption
				: resolve(this.hostCwd, this.policyOption);
			const root = await realpath(this.hostCwd);
			let target;
			try {
				target = await realpath(absolute);
			} catch (error) {
				throw new OpenShellSandboxError(
					`Could not read OpenShell policy ${this.policyOption}: ${error.message}`,
				);
			}
			const rel = relative(root, target);
			if (rel.startsWith('..') || isAbsolute(rel)) {
				throw new OpenShellSandboxError(
					`OpenShell policy must stay inside the workspace: ${this.policyOption}`,
				);
			}
			return target;
		}
		const path = join(this.runDir, DEFAULT_POLICY_FILE);
		await mkdir(this.runDir, { recursive: true });
		await writeFile(path, defaultDenyPolicy(), 'utf8');
		return path;
	}
}

export async function buildWorkspaceSnapshot(cwd, snapshotDir, options = {}) {
	const excludePaths = (options.excludePaths || []).map((path) =>
		resolve(path),
	);
	await rm(snapshotDir, { force: true, recursive: true });
	await mkdir(snapshotDir, { recursive: true });
	const entries = await readdir(cwd, { withFileTypes: true });
	for (const entry of entries) {
		if (isExcluded(entry.name)) {
			continue;
		}
		const source = join(cwd, entry.name);
		if (excludePaths.some((path) => isSameOrWithin(source, path))) {
			continue;
		}
		await validateSnapshotPath(cwd, source);
		await cp(source, join(snapshotDir, entry.name), {
			dereference: false,
			filter: async (path) => {
				if (excludePaths.some((excluded) => isSameOrWithin(path, excluded))) {
					return false;
				}
				if (path !== source && isExcluded(basename(path))) {
					return false;
				}
				await validateSnapshotPath(cwd, path);
				return true;
			},
			preserveTimestamps: true,
			recursive: true,
			verbatimSymlinks: true,
		});
	}
}

function isSameOrWithin(path, parent) {
	const rel = relative(resolve(parent), resolve(path));
	return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel));
}

function isExcluded(name) {
	if (EXCLUDED_NAMES.has(name)) {
		return true;
	}
	return (
		name === '.env' || (name.startsWith('.env.') && name !== '.env.example')
	);
}

async function validateSnapshotPath(root, path) {
	const stat = await lstat(path);
	if (!stat.isSymbolicLink()) {
		return;
	}
	const target = resolve(join(path, '..'), await readlink(path));
	const rootReal = await realpath(root);
	let targetReal;
	try {
		targetReal = await realpath(target);
	} catch {
		throw new OpenShellSandboxError(
			`OpenShell snapshot contains a broken symlink: ${relative(root, path)}`,
		);
	}
	const rel = relative(rootReal, targetReal);
	if (rel.startsWith('..') || isAbsolute(rel)) {
		throw new OpenShellSandboxError(
			`OpenShell snapshot symlink escapes workspace: ${relative(root, path)}`,
		);
	}
}

function defaultDenyPolicy() {
	return `version: 1
filesystem_policy:
  read_only: [/usr, /lib, /etc]
  read_write: [/sandbox, /tmp]
landlock:
  compatibility: best_effort
process:
  run_as_user: sandbox
  run_as_group: sandbox
network_policies: {}
`;
}

function extractGatewayEndpoint(value) {
	const text = stripAnsi(value);
	const match = /\b(?:Server|Endpoint):\s*(https?:\/\/\S+)/iu.exec(text);
	return match?.[1] || '';
}

function isLocalGateway(endpoint) {
	try {
		const url = new URL(endpoint);
		return ['127.0.0.1', 'localhost', '::1'].includes(url.hostname);
	} catch {
		return false;
	}
}

function stripAnsi(value) {
	return value.replace(/\u001b\[[0-?]*[ -/]*[@-~]/gu, '');
}

function safeName(value) {
	return value.replace(SAFE_NAME, '-').slice(0, 48) || 'run';
}

function commandError(message, args, result) {
	return new OpenShellSandboxError(message, {
		command: `openshell ${args.join(' ')}`,
		exitCode: result.exitCode,
		stderr: result.stderr,
		stdout: result.stdout,
		timedOut: result.timedOut,
	});
}

function serializeError(error) {
	return {
		details: error.details || {},
		message: error.message,
		name: error.name,
	};
}

function spawnOpenShell(args, timeoutMs, input) {
	const hasInput = input != null;
	return new Promise((resolve) => {
		const child = spawn('openshell', args, {
			shell: false,
			stdio: [hasInput ? 'pipe' : 'ignore', 'pipe', 'pipe'],
		});
		let stdout = '';
		let stderr = '';
		let timedOut = false;
		const timer = setTimeout(() => {
			timedOut = true;
			child.kill('SIGTERM');
		}, timeoutMs);
		child.stdout.setEncoding('utf8');
		child.stderr.setEncoding('utf8');
		child.stdout.on('data', (chunk) => {
			stdout += chunk;
		});
		child.stderr.on('data', (chunk) => {
			stderr += chunk;
		});
		child.on('error', (error) => {
			clearTimeout(timer);
			resolve({
				exitCode: 1,
				stderr: `${stderr}${error.message}`,
				stdout,
				timedOut,
			});
		});
		child.on('close', (code) => {
			clearTimeout(timer);
			resolve({
				exitCode: code ?? 1,
				stderr,
				stdout,
				timedOut,
			});
		});
		if (hasInput) {
			child.stdin.on('error', () => {});
			child.stdin.end(input);
		}
	});
}
