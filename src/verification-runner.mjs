import { spawn } from 'node:child_process';
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, isAbsolute, join } from 'node:path';

export class VerificationError extends Error {
	constructor(message) {
		super(message);
		this.name = 'VerificationError';
	}
}

export function parseVerificationCommand(command) {
	const parts = command.trim().split(/\s+/u);

	if (parts.length === 2 && parts[0] === 'npm' && parts[1] === 'test') {
		return {
			args: ['test'],
			bin: 'npm',
		};
	}

	if (
		parts.length === 3 &&
		parts[0] === 'npm' &&
		parts[1] === 'run' &&
		parts[2] === 'test'
	) {
		return {
			args: ['run', 'test'],
			bin: 'npm',
		};
	}

	if (parts.length === 2 && parts[0] === 'node' && parts[1] === '--test') {
		return {
			args: ['--test'],
			bin: 'node',
		};
	}

	if (
		parts.length === 3 &&
		parts[0] === 'node' &&
		parts[1] === '--check' &&
		isSafeRelativeFile(parts[2])
	) {
		return {
			args: ['--check', parts[2]],
			bin: 'node',
		};
	}

	throw new VerificationError(`Command is not allowlisted: ${command}`);
}

export async function runVerification(cwd, command, options = {}) {
	const parsed = parseVerificationCommand(command);
	const timeoutMs = options.timeoutMs || 60000;
	const startedAt = new Date().toISOString();
	const started = performance.now();
	const result = await spawnCommand(cwd, parsed, timeoutMs);
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
			'Verification commands are allowlisted and run without a shell, but npm scripts execute trusted workspace code.',
	};

	await writeLastTest(cwd, summary);
	return summary;
}

function spawnCommand(cwd, parsed, timeoutMs) {
	return new Promise((resolve) => {
		const child = spawn(parsed.bin, parsed.args, {
			cwd,
			detached: true,
			shell: false,
		});
		let stdout = '';
		let stderr = '';
		let timedOut = false;
		const timer = setTimeout(() => {
			timedOut = true;
			killProcessGroup(child);
		}, timeoutMs);

		child.stdout.setEncoding('utf8');
		child.stderr.setEncoding('utf8');
		child.stdout.on('data', (chunk) => {
			stdout += chunk;
		});
		child.stderr.on('data', (chunk) => {
			stderr += chunk;
		});
		child.on('close', (exitCode) => {
			clearTimeout(timer);
			resolve({
				exitCode,
				stderr,
				stdout,
				timedOut,
			});
		});
		child.on('error', (error) => {
			clearTimeout(timer);
			resolve({
				exitCode: 1,
				stderr: error.message,
				stdout,
				timedOut,
			});
		});
	});
}

function killProcessGroup(child) {
	try {
		process.kill(-child.pid, 'SIGTERM');
	} catch {
		child.kill('SIGTERM');
	}
}

function isSafeRelativeFile(path) {
	if (!path || isAbsolute(path)) {
		return false;
	}

	return !path.split(/[\\/]+/u).includes('..');
}

async function writeLastTest(cwd, result) {
	const path = join(cwd, '.koder', 'last-test.md');
	await mkdir(dirname(path), { recursive: true });
	await writeFile(path, renderLastTest(result), 'utf8');
}

function renderLastTest(result) {
	return `# Last Test

- Command: \`${result.command}\`
- OK: ${result.ok}
- Exit code: ${result.exitCode}
- Timed out: ${result.timedOut}
- Duration ms: ${result.durationMs}

## stdout

\`\`\`
${result.stdout}
\`\`\`

## stderr

\`\`\`
${result.stderr}
\`\`\`
`;
}
