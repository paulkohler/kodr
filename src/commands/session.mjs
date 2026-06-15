// commands/session.mjs — session list/show/export, prompt-history, and undo
// commands. Extracted from app.mjs main() in phase 148 (app split). Handlers
// that need the channel (session, undo) take handleChannelRequest as an
// injected dependency so this module never imports from app.mjs (circular).

import { CliError } from '../cli-errors.mjs';
import {
	renderSessionConversation,
	renderSessionList,
	renderSessionMarkdown,
} from '../render.mjs';
import { scanRunHistory } from '../run-history.mjs';

export async function runSession(options, io, channel) {
	const sub = options.sessionSubcommand;

	if (sub === 'list') {
		const list = await channel({ kind: 'session-list', options }, io);

		if (options.json) {
			io.stdout.write(`${JSON.stringify({ sessions: list }, null, 2)}\n`);
		} else {
			io.stdout.write(renderSessionList(list));
		}
		return {
			ok: true,
			command: 'session',
			subcommand: 'list',
			sessions: list,
		};
	}

	if (sub === 'show') {
		if (!options.sessionId) {
			throw new CliError('kodr session show requires a session id');
		}
		const conv = await channel(
			{ kind: 'session-show', options, sessionId: options.sessionId },
			io,
		);

		if (options.json) {
			io.stdout.write(`${JSON.stringify(conv, null, 2)}\n`);
		} else {
			io.stdout.write(renderSessionConversation(conv));
		}
		return {
			ok: true,
			command: 'session',
			subcommand: 'show',
			conversation: conv,
		};
	}

	if (sub === 'export') {
		if (!options.sessionId) {
			throw new CliError('kodr session export requires a session id');
		}
		if (options.sessionFormat !== 'markdown') {
			throw new CliError('kodr session export only supports --format markdown');
		}
		const conv = await channel(
			{ kind: 'session-show', options, sessionId: options.sessionId },
			io,
		);
		const markdown = renderSessionMarkdown(conv);
		io.stdout.write(markdown);
		return {
			ok: true,
			command: 'session',
			subcommand: 'export',
			conversation: conv,
			format: options.sessionFormat,
		};
	}

	throw new CliError(
		`kodr session requires a subcommand: list, show <id>, export <id>`,
	);
}

export async function runPromptHistory(options, io) {
	if (!options.promptHistoryId) {
		throw new CliError('kodr prompt-history requires a prompt id argument');
	}
	const runs = await scanRunHistory(io.cwd, options.promptHistoryId);
	const result = { promptId: options.promptHistoryId, runs };
	if (options.json) {
		io.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
	} else {
		io.stdout.write(`Prompt history: ${options.promptHistoryId}\n`);
		if (runs.length === 0) {
			io.stdout.write('  No runs found.\n');
		}
		for (const run of runs) {
			const status = run.ok ? 'ok' : 'fail';
			const evalPart =
				run.evalScore !== null ? ` eval=${run.evalScore.toFixed(2)}` : '';
			const tokenPart = run.tokens > 0 ? ` tokens=${run.tokens}` : '';
			io.stdout.write(
				`  ${run.timestamp}  ${run.model}  [${status}]${evalPart}${tokenPart}\n`,
			);
		}
	}
	return { ok: true, command: 'prompt-history', result };
}

export async function runUndo(options, io, channel) {
	const result = await channel({ kind: 'undo-run', options }, io);
	if (options.json) {
		io.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
	} else {
		io.stdout.write(`${result.message}\n`);
		for (const file of result.files || []) {
			io.stdout.write(`  ${file.action.padEnd(8)}${file.path}\n`);
		}
		for (const conflict of result.conflicts || []) {
			io.stdout.write(`  conflict ${conflict.path}: ${conflict.reason}\n`);
		}
	}
	return { ok: result.ok, command: 'undo', result };
}
