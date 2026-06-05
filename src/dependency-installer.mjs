import { spawn } from 'node:child_process';
import { access, mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

export class DependencyInstallError extends Error {
	constructor(message) {
		super(message);
		this.name = 'DependencyInstallError';
	}
}

export function parseDependencyInstallCommand(command) {
	const parts = command.trim().split(/\s+/u);

	if (parts.length === 2 && parts[0] === 'npm' && parts[1] === 'install') {
		return {
			args: ['install'],
			bin: 'npm',
		};
	}

	if (parts.length === 2 && parts[0] === 'npm' && parts[1] === 'ci') {
		return {
			args: ['ci'],
			bin: 'npm',
		};
	}

	throw new DependencyInstallError(`Command is not allowlisted: ${command}`);
}

export async function chooseDependencyInstallCommand(cwd) {
	return (await fileExists(join(cwd, 'package-lock.json')))
		? 'npm ci'
		: 'npm install';
}

export async function runDependencyInstall(cwd, options = {}) {
	const explicit = Boolean(options.command);
	const command =
		options.command || (await chooseDependencyInstallCommand(cwd));
	const timeoutMs = options.timeoutMs || 60000;
	const runner = options.runner || spawnCommand;

	let summary = await attemptInstall(cwd, command, timeoutMs, runner);

	// `npm ci` is auto-chosen whenever a lockfile exists, but it is strict: if
	// the lockfile is out of sync with package.json (common after the model
	// rewrites package.json over a stale lock) it fails with EUSAGE. Fall back
	// to `npm install`, which regenerates the lockfile. Only do this for the
	// auto-chosen command so an explicit request stays strict, and not after a
	// timeout (a retry would likely time out again).
	if (!explicit && command === 'npm ci' && !summary.ok && !summary.timedOut) {
		const fallback = await attemptInstall(
			cwd,
			'npm install',
			timeoutMs,
			runner,
		);
		fallback.fallbackFrom = 'npm ci';
		fallback.fallbackReason = lockfileOutOfSync(summary.stderr)
			? 'lockfile out of sync with package.json'
			: 'npm ci failed';
		summary = fallback;
	}

	await writeLastInstall(cwd, summary);
	return summary;
}

async function attemptInstall(cwd, command, timeoutMs, runner) {
	const parsed = parseDependencyInstallCommand(command);
	const startedAt = new Date().toISOString();
	const started = performance.now();
	const result = await runner(cwd, parsed, timeoutMs);
	return {
		command,
		durationMs: Math.round(performance.now() - started),
		exitCode: result.exitCode,
		finishedAt: new Date().toISOString(),
		ok: result.exitCode === 0 && !result.timedOut,
		stderr: result.stderr,
		stdout: result.stdout,
		timedOut: result.timedOut,
		startedAt,
		execution: result.execution || { environment: 'host' },
		trustBoundary:
			'Dependency install commands are allowlisted and run without a shell, but npm lifecycle behavior executes trusted workspace package code.',
	};
}

function lockfileOutOfSync(stderr) {
	return /can only install packages when your package\.json and package-lock\.json|in sync/u.test(
		stderr || '',
	);
}

async function fileExists(path) {
	try {
		await access(path);
		return true;
	} catch {
		return false;
	}
}

async function spawnCommand(cwd, parsed, timeoutMs) {
	return new Promise((resolve) => {
		const child = spawn(parsed.bin, parsed.args, {
			cwd,
			env: process.env,
			shell: false,
			stdio: ['ignore', 'pipe', 'pipe'],
		});
		let stdout = '';
		let stderr = '';
		let timedOut = false;
		const timer = setTimeout(() => {
			timedOut = true;
			child.kill('SIGTERM');
		}, timeoutMs);

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
	});
}

async function writeLastInstall(cwd, summary) {
	const dir = join(cwd, '.kodr');
	await mkdir(dir, { recursive: true });
	await writeFile(
		join(dir, 'last-install.md'),
		[
			`# Last dependency install`,
			``,
			`Command: ${summary.command}`,
			`OK: ${summary.ok}`,
			`Exit: ${summary.exitCode}`,
			`Timed out: ${summary.timedOut}`,
			`Duration ms: ${summary.durationMs}`,
			`Execution: ${summary.execution?.environment || 'host'}${summary.execution?.containerName ? ` (${summary.execution.containerName})` : ''}`,
			``,
			`## stdout`,
			'```',
			summary.stdout,
			'```',
			``,
			`## stderr`,
			'```',
			summary.stderr,
			'```',
		].join('\n'),
		'utf8',
	);
}
