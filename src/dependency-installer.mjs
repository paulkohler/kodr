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
	const command =
		options.command || (await chooseDependencyInstallCommand(cwd));
	const parsed = parseDependencyInstallCommand(command);
	const timeoutMs = options.timeoutMs || 60000;
	const runner = options.runner || spawnCommand;
	const startedAt = new Date().toISOString();
	const started = performance.now();
	const result = await runner(cwd, parsed, timeoutMs);
	const finishedAt = new Date().toISOString();
	const summary = {
		command,
		durationMs: Math.round(performance.now() - started),
		exitCode: result.exitCode,
		finishedAt,
		ok: result.exitCode === 0 && !result.timedOut,
		stderr: result.stderr,
		stdout: result.stdout,
		timedOut: result.timedOut,
		startedAt,
		trustBoundary:
			'Dependency install commands are allowlisted and run without a shell, but npm lifecycle behavior executes trusted workspace package code.',
	};

	await writeLastInstall(cwd, summary);
	return summary;
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
