// commands/serve.mjs — long-running serve (HTTP channel) and watch (re-run on
// file change) commands. Extracted from app.mjs main() in phase 148 (app
// split). Both take handleChannelRequest as an injected dependency (it stays
// in app.mjs) so this module never imports from app.mjs. Verbatim bodies,
// exact I/O contract.

import { CliError } from '../cli-errors.mjs';
import { startKodrServer } from '../server.mjs';

export async function runServe(options, io, channel) {
	const instance = await startKodrServer({
		channel,
		cwd: io.cwd,
		options,
	});
	io.stdout.write(`Serving: ${instance.url}\n`);
	await instance.closed;
	return { ok: true, command: 'serve', url: instance.url };
}

export async function runWatch(options, io, channel) {
	if (!options.testCommand) {
		throw new CliError('kodr watch requires --test <command>');
	}
	const { runWatchLoop } = await import('../watcher.mjs');
	const handle = await runWatchLoop(options, io, channel);
	// Block until the process is interrupted
	await new Promise((resolve) => {
		const onSignal = () => {
			handle.close();
			resolve();
		};
		process.once('SIGINT', onSignal);
		process.once('SIGTERM', onSignal);
	});
	return { ok: true, command: 'watch' };
}
