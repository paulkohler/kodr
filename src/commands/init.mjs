// commands/init.mjs — write a starter .kodr project config.
// Extracted from app.mjs main() in phase 148 (app split). Verbatim bodies,
// exact (options, io) → result contract.

import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { CliError } from '../cli-errors.mjs';
import { defaultConfigPath } from '../project-config.mjs';

export async function runInitCommand(options, io) {
	const result = await runInit(options, io);
	if (options.json) {
		io.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
	} else {
		io.stdout.write(`Wrote ${result.configPath}\n`);
	}
	return { ok: true, command: 'init', result };
}

async function runInit(options, io) {
	const configPath = defaultConfigPath(io.cwd, io.env || {});

	let exists = false;
	try {
		await readFile(configPath, 'utf8');
		exists = true;
	} catch {
		exists = false;
	}

	if (exists && !options.force) {
		throw new CliError(
			`${configPath} already exists — use kodr init --force to overwrite`,
		);
	}

	let testCommand = null;
	try {
		const pkg = JSON.parse(
			await readFile(join(io.cwd, 'package.json'), 'utf8'),
		);
		if (pkg?.scripts?.test) testCommand = 'npm test';
	} catch {
		// No package.json or no test script — omit testCommand from starter.
	}

	const config = {
		'//':
			'kodr project config — see `kodr --help` and usage.md. ' +
			'Gate keys (yes, gitCommit, installDependencies, enableHooks, apiKey) are not allowed.',
		model: options.model,
		baseUrl: options.baseUrl,
	};
	if (testCommand) {
		config.testCommand = testCommand;
	}

	await mkdir(dirname(configPath), { recursive: true });
	await writeFile(configPath, `${JSON.stringify(config, null, 2)}\n`, 'utf8');

	return {
		configPath,
		model: options.model,
		baseUrl: options.baseUrl,
		testCommand,
	};
}
