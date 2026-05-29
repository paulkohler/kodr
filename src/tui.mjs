import { createInterface } from 'node:readline/promises';
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
	const rl = createInterface({ input, output, terminal });

	output.write(`kodr ${VERSION}\n`);
	output.write(
		`session: ${state.sessionId || (state.continueNext ? 'latest' : 'new')}\n`,
	);
	output.write('Type /help for commands.\n\n');

	try {
		while (true) {
			const line = await rl.question('user> ');
			let result;
			try {
				result = await handleTuiLine(state, line, io, channel);
			} catch (error) {
				output.write(`assistant> error: ${error.message}\n`);
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

export async function handleTuiLine(state, line, io, channel) {
	const text = line.trim();
	if (!text) {
		return { ok: true, type: 'empty' };
	}

	if (text.startsWith('/')) {
		return handleSlashCommand(state, text, io, channel);
	}

	io.stdout.write('assistant> working...\n');
	const options = turnOptions(state, text);
	const result = await channel({ kind: 'run-turn', options }, io);
	state.continueNext = false;
	state.lastRunDir = result.runDir || '';
	state.sessionId = result.sessionId || state.sessionId;
	io.stdout.write(renderTurnResult(result));
	return { ok: result.ok, result, type: 'turn' };
}

async function handleSlashCommand(state, text, io, channel) {
	const [command, ...rest] = text.split(/\s+/u);
	const value = rest.join(' ').trim();

	if (command === '/quit' || command === '/exit') {
		io.stdout.write('assistant> bye\n');
		return { exit: true, ok: true, type: 'command' };
	}

	if (command === '/help') {
		io.stdout.write(renderHelp());
		return { ok: true, type: 'command' };
	}

	if (command === '/status') {
		io.stdout.write(renderStatus(state));
		return { ok: true, type: 'command' };
	}

	if (command === '/sessions') {
		const sessions = await channel(
			{ kind: 'session-list', options: state.baseOptions },
			io,
		);
		io.stdout.write(renderSessions(sessions));
		return { ok: true, sessions, type: 'command' };
	}

	if (command === '/show') {
		if (!value) {
			io.stdout.write('assistant> usage: /show <session-id>\n');
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
		io.stdout.write(renderConversation(conversation));
		return { conversation, ok: true, type: 'command' };
	}

	if (command === '/use') {
		if (!value) {
			io.stdout.write('assistant> usage: /use <session-id>\n');
			return { ok: false, type: 'command' };
		}
		state.sessionId = value;
		state.continueNext = false;
		io.stdout.write(`assistant> session=${state.sessionId}\n`);
		return { ok: true, type: 'command' };
	}

	if (command === '/new') {
		state.sessionId = '';
		state.lastRunDir = '';
		state.continueNext = false;
		io.stdout.write('assistant> session=new\n');
		return { ok: true, type: 'command' };
	}

	if (command === '/apply') {
		const next = parseToggle(value);
		if (next === null) {
			io.stdout.write('assistant> usage: /apply on|off\n');
			return { ok: false, type: 'command' };
		}
		state.apply = next;
		io.stdout.write(`assistant> apply=${state.apply ? 'on' : 'off'}\n`);
		return { ok: true, type: 'command' };
	}

	if (command === '/tools') {
		const next = parseToggle(value);
		if (next === null) {
			io.stdout.write('assistant> usage: /tools on|off\n');
			return { ok: false, type: 'command' };
		}
		state.tools = next;
		io.stdout.write(`assistant> tools=${state.tools ? 'on' : 'off'}\n`);
		return { ok: true, type: 'command' };
	}

	if (command === '/model') {
		if (!value) {
			io.stdout.write('assistant> usage: /model <id>\n');
			return { ok: false, type: 'command' };
		}
		state.model = value;
		io.stdout.write(`assistant> model=${state.model}\n`);
		return { ok: true, type: 'command' };
	}

	io.stdout.write(`assistant> unknown command: ${command}\n`);
	return { ok: false, type: 'command' };
}

function turnOptions(state, prompt) {
	return {
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
}

function renderHelp() {
	return [
		'assistant> commands:',
		'  /help',
		'  /status',
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

function renderStatus(state) {
	return [
		`assistant> session=${state.sessionId || (state.continueNext ? 'latest' : 'new')}`,
		`model=${state.model}`,
		`provider=${state.provider}`,
		`apply=${state.apply ? 'on' : 'dry-run'}`,
		`tools=${state.tools ? 'on' : 'off'}`,
		`lastRun=${state.lastRunDir || '-'}`,
		`budgets=maxTurns:${state.baseOptions.maxTurns} maxRetries:${state.baseOptions.maxRetries} maxTokens:${state.baseOptions.maxTokens || '-'} maxCostUsd:${state.baseOptions.maxCostUsd || '-'}`,
		'',
	].join('\n');
}

function renderTurnResult(result) {
	const lines = ['assistant>'];

	const messages = result.proposal?.messages || [];
	for (const message of messages) {
		lines.push(`  [${message.level}] ${message.content}`);
	}

	if (!result.proposal || result.proposalError) {
		const response = (result.response || '').trim();
		if (response) {
			lines.push(indent(response));
		}
	}

	if (result.writeResult) {
		const writes = result.writeResult.writes || [];
		const mode = result.applied ? 'applied' : 'dry-run';
		lines.push(`  writes=${writes.length} mode=${mode}`);
	}

	if (result.testResult) {
		lines.push(`  tests=${result.testResult.ok ? 'passed' : 'failed'}`);
	}

	lines.push(`  session=${result.sessionId || '-'}`);
	lines.push(`  run=${result.runDir || '-'}`);
	lines.push('');
	return `${lines.join('\n')}`;
}

function renderSessions(sessions) {
	if (sessions.length === 0) {
		return 'assistant> no sessions found\n';
	}
	const lines = ['assistant> sessions:'];
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

function renderConversation(conversation) {
	const lines = [`assistant> session: ${conversation.sessionId}`];
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
