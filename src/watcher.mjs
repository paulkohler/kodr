import { watch } from 'node:fs';

const IGNORE_DIRS = new Set([
	'.git',
	'.kodr',
	'node_modules',
	'dist',
	'build',
	'coverage',
]);

const DEFAULT_DEBOUNCE_MS = 500;
const DEFAULT_MAX_REPAIR_ATTEMPTS = 3;

/**
 * Create a file watcher for the given directory.
 * Returns { on, close } where on('change', callback) fires on debounced file changes.
 * Ignores .git, .kodr, node_modules, etc.
 *
 * @param {string} cwd - directory to watch
 * @param {object} options - { debounceMs }
 * @returns {{ on: Function, close: Function }}
 */
export function createWatcher(cwd, options = {}) {
	const debounceMs = options.debounceMs ?? DEFAULT_DEBOUNCE_MS;
	const listeners = { change: [] };
	let debounceTimer = null;
	let pendingPaths = new Set();

	const watcher = watch(cwd, { recursive: true }, (eventType, filename) => {
		if (!filename) return;
		// Skip ignored dirs — check every segment of the relative path
		const parts = filename.split(/[\\/]/u);
		if (parts.some((p) => IGNORE_DIRS.has(p))) return;

		pendingPaths.add(filename);
		clearTimeout(debounceTimer);
		debounceTimer = setTimeout(() => {
			const paths = [...pendingPaths];
			pendingPaths = new Set();
			for (const cb of listeners.change) cb(paths);
		}, debounceMs);
	});

	return {
		on(event, cb) {
			if (listeners[event]) {
				listeners[event].push(cb);
			}
		},
		close() {
			clearTimeout(debounceTimer);
			watcher.close();
		},
	};
}

/**
 * The watch loop: watch for file changes, run tests, propose repairs on failure.
 * Never auto-applies. Repairs become pending reviews.
 *
 * @param {object} options - { testCommand, model, baseUrl, ... }
 * @param {object} io - { stdout, stderr, cwd, env }
 * @param {Function} channel - handleChannelRequest
 * @returns {{ close: Function }}
 */
export async function runWatchLoop(options, io, channel) {
	const { runVerification: defaultRunVerification } = await import(
		'./verification-runner.mjs'
	);
	// Allow test injection of a verification runner
	const runVerification = options._verificationRunner ?? defaultRunVerification;

	const state = {
		watching: true,
		lastTestResult: null,
		pendingRepair: false,
		repairCount: 0,
		noProgressCount: 0,
	};

	const watcher = createWatcher(io.cwd, {
		debounceMs: options.watchDebounceMs ?? DEFAULT_DEBOUNCE_MS,
	});

	io.stdout.write(
		`[watch] Watching for file changes. Test command: ${options.testCommand}\n`,
	);
	io.stdout.write('[watch] Press Ctrl+C to stop.\n');

	watcher.on('change', async (paths) => {
		if (!state.watching) return;

		io.stdout.write(`[watch] Changed: ${paths.join(', ')}\n`);
		io.stdout.write(`[watch] Running: ${options.testCommand}\n`);

		let testResult;
		try {
			testResult = await runVerification(io.cwd, options.testCommand, {
				timeoutMs: options.timeoutMs || 60000,
			});
		} catch (err) {
			io.stderr.write(`[watch] Verification error: ${err.message}\n`);
			return;
		}

		state.lastTestResult = testResult;

		if (testResult.ok) {
			state.pendingRepair = false;
			state.repairCount = 0;
			state.noProgressCount = 0;
			io.stdout.write('[watch] Tests passed.\n');
			return;
		}

		// Tests failed — propose a repair as a pending review
		io.stdout.write(
			`[watch] Tests failed (exit ${testResult.exitCode}). Proposing repair...\n`,
		);

		// No-progress guard: if too many repair attempts without user action, stop
		if (state.repairCount >= DEFAULT_MAX_REPAIR_ATTEMPTS) {
			io.stdout.write(
				`[watch] Repair limit reached (${DEFAULT_MAX_REPAIR_ATTEMPTS} attempts). Waiting for file change.\n`,
			);
			return;
		}

		// One repair at a time: skip if a repair is already pending review
		if (state.pendingRepair) {
			io.stdout.write(
				'[watch] A repair is already pending review. Accept or reject it first.\n',
			);
			return;
		}

		state.pendingRepair = true;
		state.repairCount += 1;

		try {
			const repairResult = await channel(
				{
					kind: 'run-turn',
					options: {
						...options,
						prompt: buildRepairPrompt(testResult),
						dryRun: true,
						yes: false,
					},
				},
				io,
			);

			if (!repairResult || !repairResult.proposal) {
				state.noProgressCount += 1;
				state.pendingRepair = false;
				if (state.noProgressCount >= 2) {
					io.stdout.write(
						`[watch] No repair proposed after ${state.noProgressCount} attempts — waiting for a file change before retrying.\n`,
					);
					state.repairCount = DEFAULT_MAX_REPAIR_ATTEMPTS; // stop spinning
				} else {
					io.stdout.write(
						'[watch] No repair proposed. Will retry on next change.\n',
					);
				}
				return;
			}

			state.noProgressCount = 0;

			// Show what the repair proposes to change.
			const proposed = repairResult.proposal;
			const changedPaths = [
				...(proposed.files ?? []).map((f) => f.path),
				...(proposed.patches ?? []).map((p) => p.path),
			];
			io.stdout.write(
				`[watch] Repair proposed (${changedPaths.length} file${changedPaths.length === 1 ? '' : 's'}): ${changedPaths.join(', ')}\n`,
			);

			// In TTY mode: prompt the user to accept or reject.
			if (io.stdin?.isTTY) {
				const answer = await promptAccept(io);
				if (answer) {
					io.stdout.write('[watch] Applying repair...\n');
					try {
						await channel(
							{
								kind: 'apply-proposal',
								options,
								proposal: proposed,
								runDir: repairResult.runDir || '',
								sessionId: repairResult.sessionId || '',
							},
							io,
						);
						io.stdout.write('[watch] Repair applied.\n');
					} catch (applyErr) {
						io.stderr.write(`[watch] Apply failed: ${applyErr.message}\n`);
					}
				} else {
					io.stdout.write('[watch] Repair rejected. Watching for changes.\n');
				}
				state.pendingRepair = false;
			} else {
				// Non-TTY: leave the proposal pending for TUI /accept or /reject.
				io.stdout.write(
					'[watch] Repair pending review. Use /accept or /reject in TUI.\n',
				);
			}
		} catch (err) {
			state.pendingRepair = false;
			io.stderr.write(`[watch] Repair error: ${err.message}\n`);
		}
	});

	return {
		close() {
			state.watching = false;
			watcher.close();
			io.stdout.write('[watch] Stopped.\n');
		},
		// Expose state for testing
		_state: state,
	};
}

// Write the prompt and read one line from io.stdin.
// Resolves to true when the answer is 'y' or 'yes'.
function promptAccept(io) {
	return new Promise((resolve) => {
		io.stdout.write('[watch] Accept repair? [y/N] ');
		let buffer = '';
		function onData(chunk) {
			buffer += chunk.toString();
			const newlineIdx = buffer.indexOf('\n');
			if (newlineIdx !== -1) {
				io.stdin.off?.('data', onData);
				io.stdin.removeListener?.('data', onData);
				const answer = buffer.slice(0, newlineIdx).trim().toLowerCase();
				resolve(answer === 'y' || answer === 'yes');
			}
		}
		if (io.stdin.setEncoding) io.stdin.setEncoding('utf8');
		if (io.stdin.resume) io.stdin.resume();
		io.stdin.on('data', onData);
	});
}

/**
 * Build the repair prompt from a failed test result.
 *
 * @param {object} testResult - { stdout, stderr, exitCode, command }
 * @returns {string}
 */
function buildRepairPrompt(testResult) {
	const stdout = testResult.stdout?.slice(0, 2000) || '';
	const stderr = testResult.stderr?.slice(0, 2000) || '';
	return `Tests are failing. Propose a minimal repair.

## Test command
\`${testResult.command}\`

## Exit code
${testResult.exitCode}

## stdout
\`\`\`
${stdout}
\`\`\`

## stderr
\`\`\`
${stderr}
\`\`\`

Propose one small repair as JSON with optional files and patches fields.
Do NOT apply the changes — this is a dry-run proposal only.`;
}
