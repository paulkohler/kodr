import { createInterface } from 'node:readline/promises';
import { createAnsi } from './ansi.mjs';
import { VERSION } from './version.mjs';

export function createTuiState(options = {}) {
	return {
		apply: options.yes === true,
		baseOptions: {
			...options,
			command: 'run',
			json: false,
			out: '',
			prompt: '',
			promptFile: '',
			showContext: false,
			showFiles: false,
			showSkills: false,
		},
		continueNext: options.continueSession === true,
		lastRunDir: '',
		model: options.model || '',
		pendingReview: null,
		provider: options.provider || 'local',
		sessionId: options.sessionId || '',
		tools: options.tools === true,
	};
}

export async function runTui(options, io, channel) {
	const state = createTuiState(options);
	const input = io.stdin || process.stdin;
	const output = io.stdout || process.stdout;
	const terminal = input.isTTY === true && output.isTTY === true;
	const view = createTuiView(io);
	const rl = createInterface({ input, output, terminal });

	output.write(`${view.brand(`kodr ${VERSION}`)}\n`);
	output.write(
		view.info(
			`session: ${state.sessionId || (state.continueNext ? 'latest' : 'new')}`,
		),
	);
	output.write(`${view.infoText('Type /help for commands.')}\n\n`);

	try {
		while (true) {
			let line;
			try {
				line = await rl.question(view.userPrompt());
			} catch (error) {
				if (isReadlineClosed(error)) {
					return { ok: true, reason: 'eof', state };
				}
				throw error;
			}
			let result;
			try {
				result = await handleTuiLine(state, line, io, channel);
			} catch (error) {
				output.write(view.error(`error: ${error.message}`));
				continue;
			}
			if (result.exit) {
				return { ok: true, reason: 'quit', state };
			}
		}
	} finally {
		rl.close();
	}
}

function isReadlineClosed(error) {
	return /readline was closed/iu.test(error.message || '');
}

export function createTuiView(io = {}) {
	const stdout = io.stdout || {};
	const ansi = createAnsi({
		env: io.env || process.env,
		isTty: stdout.isTTY === true,
	});
	const label = () => ansi.cyan('assistant>');
	const line = (style, text) => `${label()} ${style(text)}\n`;

	return {
		brand: (text) => ansi.bold(text),
		error: (text) => line(ansi.red, text),
		errorText: (text) => ansi.red(text),
		info: (text) => line(ansi.gray, text),
		infoText: (text) => `${label()} ${ansi.gray(text)}`,
		label,
		message(level, text) {
			if (level === 'error') {
				return ansi.red(text);
			}
			if (level === 'warning' || level === 'warn') {
				return ansi.yellow(text);
			}
			if (level === 'success') {
				return ansi.green(text);
			}
			return ansi.gray(text);
		},
		success: (text) => line(ansi.green, text),
		successHeaderText: (text) => `${label()} ${ansi.green(text)}`,
		successText: (text) => ansi.green(text),
		subtleText: (text) => ansi.gray(text),
		userPrompt: () => ansi.cyan('user> '),
		warning: (text) => line(ansi.yellow, text),
		warningHeaderText: (text) => `${label()} ${ansi.yellow(text)}`,
		warningText: (text) => ansi.yellow(text),
	};
}

export async function handleTuiLine(state, line, io, channel) {
	const view = createTuiView(io);
	const text = line.trim();
	if (!text) {
		return { ok: true, type: 'empty' };
	}

	if (text.startsWith('/')) {
		return handleSlashCommand(state, text, io, channel);
	}

	io.stdout.write(view.info('working...'));
	if (state.pendingReview) {
		io.stdout.write(view.warning('replacing pending review with new turn'));
		state.pendingReview = null;
	}
	const options = turnOptions(state, text);
	const status = startTurnStatus(io, state, options);
	let result;
	try {
		result = await channel({ kind: 'run-turn', options }, io);
	} finally {
		status.stop();
	}
	state.continueNext = false;
	state.lastRunDir = result.runDir || '';
	state.sessionId = result.sessionId || state.sessionId;
	if (isPendingReview(result)) {
		state.pendingReview = {
			options,
			prompt: text,
			result,
		};
	}
	io.stdout.write(
		renderTurnResult(result, { streamed: status.streamed, view }),
	);
	if (state.pendingReview) {
		io.stdout.write(renderPendingReview(state.pendingReview, view));
	}
	return { ok: result.ok, result, type: 'turn' };
}

async function handleSlashCommand(state, text, io, channel) {
	const view = createTuiView(io);
	const [command, ...rest] = text.split(/\s+/u);
	const value = rest.join(' ').trim();

	if (command === '/quit' || command === '/exit') {
		io.stdout.write(view.success('bye'));
		return { exit: true, ok: true, type: 'command' };
	}

	if (command === '/help') {
		io.stdout.write(renderHelp(view));
		return { ok: true, type: 'command' };
	}

	if (command === '/status') {
		io.stdout.write(renderStatus(state, view));
		return { ok: true, type: 'command' };
	}

	if (command === '/review') {
		if (!state.pendingReview) {
			io.stdout.write(view.warning('no pending review'));
			return { ok: false, type: 'command' };
		}
		io.stdout.write(renderPendingReview(state.pendingReview, view));
		return { ok: true, review: state.pendingReview, type: 'command' };
	}

	if (command === '/reject') {
		if (!state.pendingReview) {
			io.stdout.write(view.warning('no pending review'));
			return { ok: false, type: 'command' };
		}
		state.pendingReview = null;
		io.stdout.write(view.warning('review rejected'));
		return { ok: true, type: 'command' };
	}

	if (command === '/accept') {
		if (!state.pendingReview) {
			io.stdout.write(view.warning('no pending review'));
			return { ok: false, type: 'command' };
		}
		io.stdout.write(view.info('applying pending review...'));
		const options = {
			...state.pendingReview.options,
			dryRun: false,
			yes: true,
		};
		const result = await channel({ kind: 'run-turn', options }, io);
		state.pendingReview = null;
		state.continueNext = false;
		state.lastRunDir = result.runDir || '';
		state.sessionId = result.sessionId || state.sessionId;
		io.stdout.write(renderTurnResult(result, { view }));
		return { ok: result.ok, result, type: 'command' };
	}

	if (command === '/test') {
		if (!state.pendingReview) {
			io.stdout.write(view.warning('no pending review'));
			return { ok: false, type: 'command' };
		}
		if (!state.pendingReview.options.testCommand) {
			io.stdout.write(view.warning('no test command configured'));
			return { ok: false, type: 'command' };
		}
		const testResult = await channel(
			{ kind: 'verify-command', options: state.pendingReview.options },
			io,
		);
		io.stdout.write(
			(testResult.ok ? view.success : view.error)(
				`tests=${testResult.ok ? 'passed' : 'failed'} (${testResult.command})`,
			),
		);
		return { ok: testResult.ok, testResult, type: 'command' };
	}

	if (command === '/sessions') {
		const sessions = await channel(
			{ kind: 'session-list', options: state.baseOptions },
			io,
		);
		io.stdout.write(renderSessions(sessions, view));
		return { ok: true, sessions, type: 'command' };
	}

	if (command === '/show') {
		if (!value) {
			io.stdout.write(view.warning('usage: /show <session-id>'));
			return { ok: false, type: 'command' };
		}
		const conversation = await channel(
			{
				kind: 'session-show',
				options: state.baseOptions,
				sessionId: value,
			},
			io,
		);
		io.stdout.write(renderConversation(conversation, view));
		return { conversation, ok: true, type: 'command' };
	}

	if (command === '/use') {
		if (!value) {
			io.stdout.write(view.warning('usage: /use <session-id>'));
			return { ok: false, type: 'command' };
		}
		state.sessionId = value;
		state.continueNext = false;
		io.stdout.write(view.info(`session=${state.sessionId}`));
		return { ok: true, type: 'command' };
	}

	if (command === '/new') {
		state.sessionId = '';
		state.lastRunDir = '';
		state.continueNext = false;
		io.stdout.write(view.info('session=new'));
		return { ok: true, type: 'command' };
	}

	if (command === '/apply') {
		const next = parseToggle(value);
		if (next === null) {
			io.stdout.write(view.warning('usage: /apply on|off'));
			return { ok: false, type: 'command' };
		}
		state.apply = next;
		io.stdout.write(view.info(`apply=${state.apply ? 'on' : 'off'}`));
		return { ok: true, type: 'command' };
	}

	if (command === '/tools') {
		const next = parseToggle(value);
		if (next === null) {
			io.stdout.write(view.warning('usage: /tools on|off'));
			return { ok: false, type: 'command' };
		}
		state.tools = next;
		io.stdout.write(view.info(`tools=${state.tools ? 'on' : 'off'}`));
		return { ok: true, type: 'command' };
	}

	if (command === '/model') {
		if (!value) {
			io.stdout.write(view.warning('usage: /model <id>'));
			return { ok: false, type: 'command' };
		}
		state.model = value;
		io.stdout.write(view.info(`model=${state.model}`));
		return { ok: true, type: 'command' };
	}

	io.stdout.write(view.error(`unknown command: ${command}`));
	return { ok: false, type: 'command' };
}

function turnOptions(state, prompt) {
	const options = {
		...state.baseOptions,
		command: 'run',
		continueSession: state.continueNext,
		dryRun: !state.apply,
		model: state.model,
		prompt,
		sessionId: state.continueNext ? '' : state.sessionId,
		tools: state.tools,
		yes: state.apply,
	};
	if (options.stream) {
		options.onStreamContent = (chunk) => {
			state._activeStreamed = true;
			state._activeStdout?.write(chunk);
		};
	}
	return options;
}

function startTurnStatus(io, state, options) {
	const view = createTuiView(io);
	const startedAt = Date.now();
	state._activeStreamed = false;
	state._activeStdout = io.stdout;
	io.stdout.write(
		view.infoText(
			[
				`request model=${options.model}`,
				`provider=${state.provider}`,
				`session=${options.sessionId || (options.continueSession ? 'latest' : 'new')}`,
				`apply=${options.yes ? 'on' : 'dry-run'}`,
				`tools=${options.tools ? 'on' : 'off'}`,
				`timeoutMs=${options.timeoutMs}`,
				`budgets=maxTurns:${options.maxTurns} maxRetries:${options.maxRetries} maxTokens:${options.maxTokens || '-'} maxCostUsd:${options.maxCostUsd || '-'}`,
			].join(' '),
		) + '\n',
	);
	if (options.stream) {
		io.stdout.write(view.info('stream:'));
	}
	const interval = setInterval(() => {
		const elapsedSeconds = Math.floor((Date.now() - startedAt) / 1000);
		io.stdout.write(view.info(`elapsed=${elapsedSeconds}s`));
	}, options.tuiStatusIntervalMs || 5000);
	interval.unref?.();
	return {
		get streamed() {
			return state._activeStreamed;
		},
		stop() {
			clearInterval(interval);
			if (state._activeStreamed) {
				io.stdout.write('\n');
			}
			state._activeStdout = null;
		},
	};
}

function renderHelp(view = createTuiView()) {
	return [
		view.infoText('commands:'),
		'  /help',
		'  /status',
		'  /review',
		'  /accept',
		'  /reject',
		'  /test',
		'  /sessions',
		'  /show <session-id>',
		'  /use <session-id>',
		'  /new',
		'  /apply on|off',
		'  /tools on|off',
		'  /model <id>',
		'  /quit',
		'',
	].join('\n');
}

function renderStatus(state, view = createTuiView()) {
	return [
		view.infoText(
			`session=${state.sessionId || (state.continueNext ? 'latest' : 'new')}`,
		),
		`model=${state.model}`,
		`provider=${state.provider}`,
		`apply=${state.apply ? 'on' : 'dry-run'}`,
		`tools=${state.tools ? 'on' : 'off'}`,
		`lastRun=${state.lastRunDir || '-'}`,
		`pendingReview=${state.pendingReview ? 'yes' : 'no'}`,
		`budgets=maxTurns:${state.baseOptions.maxTurns} maxRetries:${state.baseOptions.maxRetries} maxTokens:${state.baseOptions.maxTokens || '-'} maxCostUsd:${state.baseOptions.maxCostUsd || '-'}`,
		'',
	].join('\n');
}

function renderTurnResult(result, options = {}) {
	const view = options.view || createTuiView();
	const lines = [view.label()];

	const messages = result.proposal?.messages || [];
	for (const message of messages) {
		lines.push(
			`  ${view.message(message.level, `[${message.level}] ${message.content}`)}`,
		);
	}

	if ((!result.proposal || result.proposalError) && !options.streamed) {
		const response = (result.response || '').trim();
		if (response) {
			lines.push(indent(response));
		}
	}

	if (result.writeResult) {
		const writes = result.writeResult.writes || [];
		const mode = result.applied ? 'applied' : 'dry-run';
		const line = `writes=${writes.length} mode=${mode}`;
		lines.push(
			`  ${result.applied ? view.successText(line) : view.warningText(line)}`,
		);
	}

	if (result.testResult) {
		const line = `tests=${result.testResult.ok ? 'passed' : 'failed'}`;
		lines.push(
			`  ${result.testResult.ok ? view.successText(line) : view.errorText(line)}`,
		);
	}

	lines.push(`  session=${result.sessionId || '-'}`);
	lines.push(`  run=${result.runDir || '-'}`);
	lines.push('');
	return `${lines.join('\n')}`;
}

function isPendingReview(result) {
	if (result.applied) {
		return false;
	}
	const writes = result.writeResult?.writes || [];
	return writes.length > 0;
}

function renderPendingReview(review, view = createTuiView()) {
	const result = review.result;
	const writes = result.writeResult?.writes || [];
	const lines = [
		view.warningHeaderText('pending review:'),
		`  run=${result.runDir || '-'}`,
		`  session=${result.sessionId || '-'}`,
		`  writes=${writes.length}`,
	];
	for (const write of writes) {
		lines.push(`  ${write.status || 'pending'} ${write.path}`);
	}
	const messages = result.proposal?.messages || [];
	for (const message of messages) {
		lines.push(
			`  ${view.message(message.level, `[${message.level}] ${message.content}`)}`,
		);
	}
	lines.push(`  ${view.subtleText('commands: /review /accept /reject /test')}`);
	lines.push('');
	return lines.join('\n');
}

function renderSessions(sessions, view = createTuiView()) {
	if (sessions.length === 0) {
		return view.warning('no sessions found');
	}
	const lines = [view.infoText('sessions:')];
	for (const session of sessions) {
		const status =
			session.ok === null || session.ok === undefined
				? '?'
				: session.ok
					? 'ok'
					: 'fail';
		lines.push(
			`  ${session.sessionId} turns=${session.turnCount} [${status}] ${session.model}`,
		);
	}
	lines.push('');
	return lines.join('\n');
}

function renderConversation(conversation, view = createTuiView()) {
	const lines = [view.infoText(`session: ${conversation.sessionId}`)];
	for (const [index, turn] of conversation.turns.entries()) {
		lines.push(`  turn ${index + 1}`);
		lines.push(`    user: ${truncate(turn.user)}`);
		lines.push(`    assistant: ${truncate(turn.assistant)}`);
	}
	lines.push('');
	return lines.join('\n');
}

function parseToggle(value) {
	if (value === 'on') {
		return true;
	}
	if (value === 'off') {
		return false;
	}
	return null;
}

function indent(text) {
	return text
		.split('\n')
		.map((line) => `  ${line}`)
		.join('\n');
}

function truncate(text) {
	return `${text.slice(0, 120)}${text.length > 120 ? '...' : ''}`;
}
