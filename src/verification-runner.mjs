import { spawn } from 'node:child_process';
import { access, mkdir, readdir, writeFile } from 'node:fs/promises';
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
		parts[1] === '--test' &&
		isSafeRelativeFile(parts[2])
	) {
		return {
			args: ['--test', parts[2]],
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
	const runner = options.runner || spawnCommand;
	const startedAt = new Date().toISOString();
	const started = performance.now();
	if (parsed.bin === 'npm' && !(await fileExists(join(cwd, 'package.json')))) {
		const summary = {
			command,
			durationMs: Math.round(performance.now() - started),
			exitCode: null,
			finishedAt: new Date().toISOString(),
			ok: false,
			stderr:
				'npm verification requires package.json in the verification cwd; refusing to let npm climb to a parent package.',
			stdout: '',
			timedOut: false,
			startedAt,
			execution: { environment: 'host' },
			trustBoundary:
				'Verification commands are allowlisted and run without a shell, but npm scripts execute trusted workspace code.',
		};
		await writeLastTest(cwd, summary);
		return summary;
	}
	const result = await runner(cwd, parsed, timeoutMs);
	const finishedAt = new Date().toISOString();
	const summary = {
		command,
		durationMs: Math.round(performance.now() - started),
		exitCode: result.exitCode,
		finishedAt,
		ok:
			result.exitCode === 0 &&
			!result.timedOut &&
			(await hasRequiredTestCoverage(cwd, command, result.stdout)),
		stderr: result.stderr,
		stdout: result.stdout,
		timedOut: result.timedOut,
		startedAt,
		execution: result.execution || { environment: 'host' },
		trustBoundary:
			'Verification commands are allowlisted and run without a shell, but npm scripts execute trusted workspace code.',
	};

	await writeLastTest(cwd, summary);
	return summary;
}

export async function resolveVerificationCommand(cwd, command) {
	const parsed = parseVerificationCommand(command);
	if (
		parsed.bin === 'npm' &&
		!(await fileExists(join(cwd, 'package.json'))) &&
		(await hasTestFiles(cwd))
	) {
		return {
			command: 'node --test',
			reason:
				'Requested npm verification requires package.json; using native Node tests found in the workspace.',
			requestedCommand: command,
		};
	}
	return {
		command,
		reason: '',
		requestedCommand: command,
	};
}

async function fileExists(path) {
	try {
		await access(path);
		return true;
	} catch {
		return false;
	}
}

async function hasRequiredTestCoverage(cwd, command, stdout) {
	if (!/\btest\b/u.test(command)) {
		return true;
	}

	const match = /tests\s+(\d+)/u.exec(stdout);
	if (!match) {
		return !/node --test/u.test(stdout) || (await hasTestFiles(cwd));
	}

	return Number(match[1]) > 0;
}

async function hasTestFiles(cwd) {
	const files = [];
	await collectFiles(cwd, cwd, files);
	return files.some((file) => {
		return (
			file.startsWith('test/') &&
			(/\.test\.[cm]?js$/u.test(file) || /-test\.[cm]?js$/u.test(file))
		);
	});
}

async function collectFiles(root, dir, files) {
	let entries;
	try {
		entries = await readdir(dir, { withFileTypes: true });
	} catch {
		return;
	}

	for (const entry of entries) {
		if (entry.name === 'node_modules' || entry.name === '.kodr') {
			continue;
		}

		const path = join(dir, entry.name);
		const relativePath = path.slice(root.length + 1);
		if (entry.isDirectory()) {
			await collectFiles(root, path, files);
		} else if (entry.isFile()) {
			files.push(relativePath);
		}
	}
}

function spawnCommand(cwd, parsed, timeoutMs) {
	return new Promise((resolve) => {
		// Strip the Node.js test-runner's IPC vars so nested `node --test` runs
		// don't trigger the "called recursively" short-circuit added in Node 24.
		const env = { ...process.env };
		delete env.NODE_TEST_CONTEXT;
		delete env.NODE_CHANNEL_FD;

		const child = spawn(parsed.bin, parsed.args, {
			cwd,
			detached: true,
			env,
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
	const path = join(cwd, '.kodr', 'last-test.md');
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
- Execution: ${result.execution?.environment || 'host'}${result.execution?.containerName ? ` (${result.execution.containerName})` : ''}

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
