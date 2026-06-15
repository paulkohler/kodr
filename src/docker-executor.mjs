import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { basename } from 'node:path';
// Pure option helpers live in sandbox-options.mjs (phase 149) so parse-time
// validation in cli/args.mjs does not statically pull in this heavy module.
// dockerDefaults is used by the executor below; the rest are re-exported so
// existing importers (cli/args, tests) keep working.
import { dockerDefaults } from './sandbox-options.mjs';

export {
	DockerSandboxError,
	dockerDefaults,
	validateDockerOptions,
} from './sandbox-options.mjs';

const SAFE_CONTAINER_NAME = /[^a-zA-Z0-9_.-]+/gu;

export function createDockerExecutor(hostCwd, runDir, options = {}) {
	if (!options.dockerSandbox) {
		return null;
	}
	return new DockerExecutor(hostCwd, runDir, options);
}

export class DockerExecutor {
	constructor(hostCwd, runDir, options = {}) {
		const defaults = dockerDefaults(options);
		this.backend = 'docker';
		this.hostCwd = hostCwd;
		this.runId = safeName(basename(runDir || 'run'));
		this.image = defaults.dockerImage;
		this.keep = defaults.dockerKeep;
		this.network = defaults.dockerNetwork;
		this.workdir = defaults.dockerWorkdir;
		this.runner = options.dockerRunner || spawnDocker;
		this.commands = [];
		this.sequence = 0;
	}

	async initialize() {}

	async syncWorkspace() {}

	async finalize() {}

	async run(cwd, parsed, timeoutMs, options = {}) {
		this.sequence += 1;
		const containerName = `kodr-${this.runId}-${this.sequence}-${randomBytes(3).toString('hex')}`;
		const command = `${parsed.bin} ${parsed.args.join(' ')}`.trim();
		const dockerArgs = this.dockerRunArgs(cwd, parsed, containerName, options);
		const startedAt = new Date().toISOString();
		const started = performance.now();
		const result = await this.runner(dockerArgs, timeoutMs);
		const finishedAt = new Date().toISOString();
		const record = {
			command,
			containerName,
			durationMs: Math.round(performance.now() - started),
			exitCode: result.exitCode,
			finishedAt,
			image: this.image,
			inspectCommand: `docker inspect ${containerName}`,
			kept: this.keep,
			network: this.network,
			readOnlyWorkspace: options.readOnlyWorkspace === true,
			shellCommand: this.keep
				? `docker start ${containerName} && docker exec -it ${containerName} sh`
				: '',
			startedAt,
			timedOut: result.timedOut,
			workspaceMount: {
				container: this.workdir,
				host: cwd,
			},
		};
		this.commands.push(record);

		return {
			...result,
			execution: {
				environment: 'docker',
				...record,
			},
		};
	}

	// Returns a hook executor that runs command hooks inside the sandbox so they
	// share the install/test/tool environment. Hook input JSON is piped on stdin
	// via `docker run -i`. Hook runs are audited in hooks.json (with
	// environment: "docker"), not in docker.json's command list.
	hookExecutor() {
		return {
			environment: 'docker',
			runHook: (cwd, hook, input, timeoutMs) =>
				this.runHookInContainer(cwd, hook, input, timeoutMs),
		};
	}

	async runHookInContainer(cwd, hook, input, timeoutMs) {
		this.sequence += 1;
		const containerName = `kodr-hook-${this.runId}-${this.sequence}-${randomBytes(3).toString('hex')}`;
		const args = [
			'run',
			'-i',
			'--name',
			containerName,
			'--network',
			this.network,
			'--workdir',
			this.workdir,
			'--mount',
			`type=bind,src=${cwd},dst=${this.workdir}`,
			'--env',
			'npm_config_cache=/tmp/.npm',
			'--rm',
		];
		const user = dockerUser();
		if (user) {
			args.push('--user', user);
		}
		args.push(this.image, hook.command, ...(hook.args || []).map(String));
		return this.runner(args, timeoutMs, input);
	}

	dockerRunArgs(cwd, parsed, containerName, options = {}) {
		const args = [
			'run',
			'--name',
			containerName,
			'--network',
			options.network || this.network,
			'--workdir',
			this.workdir,
			'--mount',
			`type=bind,src=${cwd},dst=${this.workdir}${options.readOnlyWorkspace ? ',readonly' : ''}`,
			'--env',
			'npm_config_cache=/tmp/.npm',
		];
		if (!this.keep) {
			args.push('--rm');
		}
		const user = dockerUser();
		if (user) {
			args.push('--user', user);
		}
		args.push(this.image, parsed.bin, ...parsed.args);
		return args;
	}

	metadata() {
		return {
			commands: this.commands,
			enabled: true,
			image: this.image,
			inspectCommand:
				this.commands.length > 0
					? `docker inspect ${this.commands.at(-1).containerName}`
					: '',
			kept: this.keep,
			network: this.network,
			shellCommand:
				this.keep && this.commands.length > 0
					? `docker start ${this.commands.at(-1).containerName} && docker exec -it ${this.commands.at(-1).containerName} sh`
					: '',
			workspaceMount: {
				container: this.workdir,
				host: this.hostCwd,
			},
		};
	}
}

function safeName(value) {
	return value.replace(SAFE_CONTAINER_NAME, '-').slice(0, 48) || 'run';
}

function dockerUser() {
	if (
		typeof process.getuid !== 'function' ||
		typeof process.getgid !== 'function'
	) {
		return '';
	}
	const uid = process.getuid();
	const gid = process.getgid();
	return uid > 0 ? `${uid}:${gid}` : '';
}

function spawnDocker(args, timeoutMs, input) {
	const hasInput = input != null;
	return new Promise((resolve) => {
		const child = spawn('docker', args, {
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
