import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { createInterface } from 'node:readline/promises';
import { createAnsi } from './ansi.mjs';
import { renderInspection, renderReferences } from './inspection-output.mjs';
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
		lastPrompt: '',
		lastRunDir: '',
		model: options.model || '',
		pendingPermission: null,
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

	// Phase 144: use the readline async iterator so lines buffered while a turn
	// is in-flight are not lost. With rl.question() each call registers a one-time
	// 'line' listener; if a line arrives before the next call is made (e.g. during
	// a slow model turn), it fires into the void and is dropped. The async iterator
	// queues every 'line' event internally and yields them in order.
	if (terminal) {
		rl.setPrompt(view.userPrompt());
		rl.prompt();
	}

	try {
		for await (const line of rl) {
			if (!terminal) {
				output.write(view.userPrompt());
			}
			let result;
			try {
				result = await handleTuiLine(state, line, io, channel);
			} catch (error) {
				output.write(view.error(`error: ${error.message}`));
				if (terminal) rl.prompt();
				continue;
			}
			if (result.exit) {
				return { ok: true, reason: 'quit', state };
			}
			if (terminal) {
				rl.prompt();
			}
		}
		return { ok: true, reason: 'eof', state };
	} finally {
		rl.close();
	}
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
		cyanText: (text) => ansi.cyan(text),
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
	const cwd = io.cwd || process.cwd();
	const { expandedPrompt, files: attachedFiles } = await expandFileReferences(
		text,
		cwd,
	);
	if (attachedFiles.length > 0) {
		const summary = attachedFiles
			.map((f) => `${f.path} (${f.chars} chars)`)
			.join(', ');
		io.stdout.write(view.info(`attached: ${summary}`));
	}
	const options = turnOptions(state, expandedPrompt, io);
	state.lastPrompt = text;
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
	if (result.permissionRequest) {
		state.pendingPermission = result.permissionRequest;
		io.stdout.write(renderPendingPermission(state.pendingPermission, view));
	}
	io.stdout.write(renderFooter(state, result, view));
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
		io.stdout.write(renderFooter(state, null, view));
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

	if (command === '/allow' || command === '/deny') {
		if (!state.pendingPermission) {
			io.stdout.write(view.warning('no pending permission'));
			return { ok: false, type: 'command' };
		}
		const decision = command === '/allow' ? 'allow' : 'deny';
		const result = await channel(
			{
				decision,
				kind: 'permission-decision',
				reason: value,
				request: state.pendingPermission,
			},
			io,
		);
		state.pendingPermission = null;
		io.stdout.write(
			(decision === 'allow' ? view.success : view.warning)(
				`permission ${result.status}`,
			),
		);
		return { ok: result.decision === 'allow', result, type: 'command' };
	}

	if (command === '/accept') {
		if (!state.pendingReview) {
			io.stdout.write(view.warning('no pending review'));
			return { ok: false, type: 'command' };
		}
		const { result: pendingResult, options } = state.pendingReview;
		if (!pendingResult.proposal) {
			io.stdout.write(
				view.error('no proposal in pending review — nothing to apply'),
			);
			return { ok: false, type: 'command' };
		}
		io.stdout.write(view.info('applying pending writes...'));
		const result = await channel(
			{
				kind: 'apply-proposal',
				options,
				proposal: pendingResult.proposal,
				runDir: pendingResult.runDir,
				sessionId: pendingResult.sessionId,
			},
			io,
		);
		state.pendingReview = null;
		state.continueNext = false;
		state.lastRunDir = result.runDir || state.lastRunDir;
		io.stdout.write(renderTurnResult(result, { view }));
		return { ok: result.ok, result, type: 'command' };
	}

	if (command === '/undo') {
		const result = await channel(
			{ kind: 'undo-run', options: state.baseOptions },
			io,
		);
		io.stdout.write((result.ok ? view.success : view.warning)(result.message));
		for (const file of result.files || []) {
			io.stdout.write(view.info(`${file.action.padEnd(8)}${file.path}`));
		}
		for (const conflict of result.conflicts || []) {
			io.stdout.write(
				view.warning(`conflict ${conflict.path}: ${conflict.reason}`),
			);
		}
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

	if (command === '/inspect') {
		if (!value) {
			io.stdout.write(view.warning('usage: /inspect <symbol-or-file>'));
			return { ok: false, type: 'command' };
		}
		const filePath = looksLikePath(value) ? value : '';
		const symbol = filePath ? '' : value;
		const index = await channel(
			{
				filePath,
				kind: 'inspect',
				options: state.baseOptions,
				symbol,
			},
			io,
		);
		io.stdout.write(
			view.infoText('inspection') +
				'\n' +
				renderInspection(index, { filePath, symbolName: symbol }),
		);
		return { index, ok: true, type: 'command' };
	}

	if (command === '/refs') {
		if (!value) {
			io.stdout.write(view.warning('usage: /refs <symbol>'));
			return { ok: false, type: 'command' };
		}
		const index = await channel(
			{
				kind: 'inspect',
				options: state.baseOptions,
				symbol: value,
			},
			io,
		);
		io.stdout.write(view.infoText('references') + '\n');
		io.stdout.write(renderReferences(index, value));
		return { index, ok: true, type: 'command' };
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

	if (command === '/why') {
		const runIdOrPath = value || '';
		const {
			resolveRunDir,
			loadRunAnalysis,
			buildCausalStory,
			renderForensicsCli,
		} = await import('./forensics.mjs');
		let runDir;
		try {
			runDir = await resolveRunDir(
				io.cwd,
				runIdOrPath || state.lastRunDir || '',
			);
		} catch (err) {
			io.stdout.write(view.error(err.message));
			return { ok: false, type: 'command' };
		}
		const analysis = await loadRunAnalysis(runDir);
		const story = buildCausalStory(analysis);
		io.stdout.write(renderForensicsCli(analysis, story));
		return { ok: true, story, type: 'command' };
	}

	if (command === '/retry') {
		if (!state.lastPrompt) {
			io.stdout.write(view.warning('no previous prompt to retry'));
			return { ok: false, type: 'command' };
		}
		// Parse optional --model <id>
		let retryModel = state.model;
		const modelFlagMatch = /--model\s+(\S+)/u.exec(value);
		if (modelFlagMatch) {
			retryModel = modelFlagMatch[1];
		}
		const savedModel = state.model;
		state.model = retryModel;
		io.stdout.write(view.info(`retrying: ${state.lastPrompt}`));
		const result = await handleTuiLine(state, state.lastPrompt, io, channel);
		state.model = savedModel;
		return result;
	}

	io.stdout.write(view.error(`unknown command: ${command}`));
	return { ok: false, type: 'command' };
}

function looksLikePath(value) {
	return /[\\/]/u.test(value) || /\.[A-Za-z0-9]+$/u.test(value);
}

function turnOptions(state, prompt, io = {}) {
	const view = createTuiView(io);
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
	options.onProgress = (event) => {
		state._activeStdout?.write(renderProgressEvent(event, view));
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
		'  /allow',
		'  /deny',
		'  /test',
		'  /undo',
		'  /retry [--model <id>]',
		'  /why [run-dir]',
		'  /sessions',
		'  /show <session-id>',
		'  /inspect <symbol-or-file>',
		'  /refs <symbol>',
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
		`pendingPermission=${state.pendingPermission ? 'yes' : 'no'}`,
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

	if (result.proposalError && !options.streamed) {
		lines.push(
			`  ${view.errorText(`response not usable (${result.proposalError.name}): ${result.proposalError.message}`)}`,
		);
	} else if (!result.proposal && !options.streamed) {
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

	if (result.orchestration) {
		const review = result.orchestration.review || result.review || {};
		const planner = result.orchestration.agents?.planner || {};
		lines.push(
			`  ${view.subtleText(`planner=${planner.planChars || 0} chars`)}`,
		);
		lines.push(
			`  ${(review.pass ? view.successText : view.errorText)(
				`review=${review.pass ? 'passed' : 'failed'} ${review.summary || ''}`.trim(),
			)}`,
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
	const coloredDiff = renderColoredDiff(writes, view);
	if (coloredDiff) {
		lines.push(coloredDiff);
	}
	const messages = result.proposal?.messages || [];
	for (const message of messages) {
		lines.push(
			`  ${view.message(message.level, `[${message.level}] ${message.content}`)}`,
		);
	}
	lines.push(`  ${view.errorText('writes NOT applied — dry-run mode')}`);
	lines.push(
		`  ${view.subtleText('commands: /accept (apply) /review /reject /test')}`,
	);
	lines.push('');
	return lines.join('\n');
}

function renderPendingPermission(permission, view = createTuiView()) {
	const lines = [
		view.warningHeaderText('permission required:'),
		`  action=${permission.action}`,
		`  reason=${permission.reason || '-'}`,
		`  input=${JSON.stringify(permission.input || {})}`,
		`  ${view.subtleText('commands: /allow /deny')}`,
		'',
	];
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

export function renderColoredDiff(writes, view = createTuiView()) {
	const lines = [];
	for (const write of writes) {
		if (!write.diff) {
			continue;
		}
		lines.push(view.subtleText(`--- diff: ${write.path} ---`));
		for (const diffLine of write.diff.split('\n')) {
			if (diffLine.startsWith('---') || diffLine.startsWith('+++')) {
				lines.push(view.brand(diffLine));
			} else if (diffLine.startsWith('@@')) {
				lines.push(view.cyanText(diffLine));
			} else if (diffLine.startsWith('+')) {
				lines.push(view.successText(diffLine));
			} else if (diffLine.startsWith('-')) {
				lines.push(view.errorText(diffLine));
			} else {
				lines.push(diffLine);
			}
		}
	}
	return lines.length > 0 ? `${lines.join('\n')}\n` : '';
}

export async function expandFileReferences(text, cwd = process.cwd()) {
	const pattern = /@([A-Za-z0-9._/-]+\.[A-Za-z0-9]+)/gu;
	const matches = [...text.matchAll(pattern)];
	if (matches.length === 0) {
		return { expandedPrompt: text, files: [] };
	}
	const seen = new Set();
	const files = [];
	const contextParts = [];
	for (const match of matches) {
		const ref = match[1];
		if (seen.has(ref)) {
			continue;
		}
		seen.add(ref);
		const filePath = join(cwd, ref);
		let content;
		try {
			content = await readFile(filePath, 'utf8');
		} catch {
			continue;
		}
		files.push({ chars: content.length, path: ref });
		contextParts.push(`## @${ref}\n\`\`\`\n${content}\n\`\`\`\n`);
	}
	if (contextParts.length === 0) {
		return { expandedPrompt: text, files: [] };
	}
	const expandedPrompt = `${contextParts.join('\n')}\n${text}`;
	return { expandedPrompt, files };
}

export function renderFooter(state, result, view = createTuiView()) {
	const model = state.model || '-';
	const session = state.sessionId || (state.continueNext ? 'latest' : 'new');
	const review = state.pendingReview ? '[review pending]' : '';
	const usage = result?.usage;
	let tokens = '';
	if (usage) {
		const prompt = usage.promptTokens ?? 0;
		const completion = usage.completionTokens ?? 0;
		const total = usage.tokens ?? prompt + completion;
		tokens = `[tokens prompt=${prompt} completion=${completion} total=${total}]`;
	}
	const parts = [
		`[model=${model}]`,
		`[session=${session}]`,
		review,
		tokens,
	].filter(Boolean);
	return `${view.subtleText(parts.join(' '))}\n`;
}

function renderProgressEvent(event, view = createTuiView()) {
	const name = event.event || 'progress';
	if (name === 'agent_start' || name === 'subagent_start') {
		return view.info(
			`${event.agent || 'agent'} started model=${event.model || '-'}`,
		);
	}
	if (name === 'agent_finish' || name === 'subagent_finish') {
		const response =
			typeof event.responseChars === 'number'
				? ` response=${event.responseChars} chars`
				: '';
		const duration =
			typeof event.durationMs === 'number'
				? ` duration=${event.durationMs}ms`
				: '';
		return view.info(
			`${event.agent || 'agent'} finished${response}${duration}`,
		);
	}
	return view.info(event.message || name);
}

function truncate(text) {
	return `${text.slice(0, 120)}${text.length > 120 ? '...' : ''}`;
}
