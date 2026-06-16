import { spawn } from 'node:child_process';
import { access, mkdir, readdir, readFile, writeFile } from 'node:fs/promises';
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

	// pnpm/yarn run the workspace's own "test" script, exactly like `npm test`
	// (same no-shell spawn, same trust boundary). Allowlisted so auto-detection
	// (phase 150) can pick the right package manager from the lockfile.
	if (parts.length === 2 && parts[0] === 'pnpm' && parts[1] === 'test') {
		return { args: ['test'], bin: 'pnpm' };
	}

	if (parts.length === 2 && parts[0] === 'yarn' && parts[1] === 'test') {
		return { args: ['test'], bin: 'yarn' };
	}

	// `pytest` discovers and runs the project's test suite from the cwd.
	if (parts.length === 1 && parts[0] === 'pytest') {
		return { args: [], bin: 'pytest' };
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

	if (
		parts.length === 3 &&
		parts[0] === 'python3' &&
		parts[1] === '-m' &&
		parts[2] === 'unittest'
	) {
		return { args: ['-m', 'unittest'], bin: 'python3' };
	}

	if (
		parts.length === 4 &&
		parts[0] === 'python3' &&
		parts[1] === '-m' &&
		parts[2] === 'unittest' &&
		parts[3] === 'discover'
	) {
		return { args: ['-m', 'unittest', 'discover'], bin: 'python3' };
	}

	if (
		parts.length === 3 &&
		parts[0] === 'go' &&
		parts[1] === 'test' &&
		parts[2] === './...'
	) {
		return { args: ['test', './...'], bin: 'go' };
	}

	if (parts.length === 2 && parts[0] === 'cargo' && parts[1] === 'test') {
		return { args: ['test'], bin: 'cargo' };
	}

	throw new VerificationError(`Command is not allowlisted: ${command}`);
}

export async function runVerification(cwd, command, options = {}) {
	const parsed = parseVerificationCommand(command);
	const timeoutMs = options.timeoutMs || 60000;
	const runner = options.runner || spawnCommand;
	const startedAt = new Date().toISOString();
	const started = performance.now();
	const needsPackageJson =
		parsed.bin === 'npm' || parsed.bin === 'pnpm' || parsed.bin === 'yarn';
	if (needsPackageJson && !(await fileExists(join(cwd, 'package.json')))) {
		const summary = {
			command,
			durationMs: Math.round(performance.now() - started),
			exitCode: null,
			finishedAt: new Date().toISOString(),
			ok: false,
			stderr: `${parsed.bin} verification requires package.json in the verification cwd; refusing to let ${parsed.bin} climb to a parent package.`,
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

/**
 * Detect a sensible, allowlisted verification command from the workspace by file
 * presence (phase 150). Returns '' when nothing recognisable is found. Node is
 * checked first (kodr's home turf); the package manager is chosen from the
 * lockfile when package.json declares a test script.
 *
 * @param {string} cwd - Workspace root (absolute path).
 * @returns {Promise<string>}
 */
export async function detectTestCommand(cwd) {
	const present = (name) => fileExists(join(cwd, name));

	if (await present('package.json')) {
		if (await packageJsonHasTestScript(cwd)) {
			if (await present('pnpm-lock.yaml')) return 'pnpm test';
			if (await present('yarn.lock')) return 'yarn test';
			return 'npm test';
		}
		// package.json without a test script: use native Node tests if present.
		if (await hasTestFiles(cwd)) return 'node --test';
	} else if (await hasTestFiles(cwd)) {
		return 'node --test';
	}

	if (await present('Cargo.toml')) return 'cargo test';
	if (await present('go.mod')) return 'go test ./...';

	// Python: prefer pytest when its config markers are present, else unittest.
	if (
		(await present('pytest.ini')) ||
		(await present('conftest.py')) ||
		(await pyprojectUsesPytest(cwd))
	) {
		return 'pytest';
	}
	if (
		(await present('pyproject.toml')) ||
		(await present('setup.py')) ||
		(await present('setup.cfg')) ||
		(await present('tox.ini'))
	) {
		return 'python3 -m unittest discover';
	}

	return '';
}

async function packageJsonHasTestScript(cwd) {
	try {
		const pkg = JSON.parse(await readFile(join(cwd, 'package.json'), 'utf8'));
		return Boolean(pkg?.scripts?.test);
	} catch {
		return false;
	}
}

async function pyprojectUsesPytest(cwd) {
	try {
		return /\[tool\.pytest/u.test(
			await readFile(join(cwd, 'pyproject.toml'), 'utf8'),
		);
	} catch {
		return false;
	}
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
