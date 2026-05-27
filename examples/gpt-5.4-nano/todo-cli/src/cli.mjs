import process from 'node:process';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { TodoStore } from './store.mjs';

const __filename = fileURLToPath(import.meta.url);
const __dirname = resolve(__filename, '..');

function parseArgs(argv) {
	const args = {
		file: null,
		cmd: null,
		cmdArgs: [],
	};

	for (let i = 0; i < argv.length; i += 1) {
		const arg = argv[i];
		if (arg === '--file') {
			const value = argv[i + 1];
			if (!value) throw new Error('--file requires a value');
			args.file = value;
			i += 1;
			continue;
		}

		if (!args.cmd) {
			args.cmd = arg;
			args.cmdArgs = argv.slice(i + 1);
			break;
		}
	}

	return args;
}

function usage() {
	return `Usage:\n\n  node src/cli.mjs [--file <path>] add <text>\n  node src/cli.mjs [--file <path>] list\n  node src/cli.mjs [--file <path>] done <id>\n  node src/cli.mjs [--file <path>] delete <id>\n\n`;
}

const argv = process.argv.slice(2);

let exitCode = 0;
try {
	const { file, cmd, cmdArgs } = parseArgs(argv);
	if (!cmd) {
		process.stdout.write(usage());
		process.exitCode = 1;
		exitCode = 1;
	} else if (cmd === '--help' || cmd === 'help') {
		process.stdout.write(usage());
	} else {
		const storeFile = file
			? resolve(file)
			: resolve(__dirname, '..', 'todos.json');

		const store = new TodoStore({ filePath: storeFile });

		switch (cmd) {
			case 'add': {
				const text = cmdArgs.join(' ').trim();
				if (!text) throw new Error('add requires <text>');
				const todo = await store.add(text);
				process.stdout.write(`Added ${todo.id}`);
				process.stdout.write(`\n${todo.text}\n`);
				break;
			}
			case 'list': {
				const todos = await store.list();
				for (const t of todos) {
					const mark = t.done ? '[x]' : '[ ]';
					process.stdout.write(`${mark} ${t.id} ${t.text}\n`);
				}
				break;
			}
			case 'done': {
				const id = cmdArgs[0];
				if (!id) throw new Error('done requires <id>');
				await store.setDone(id, true);
				process.stdout.write(`Done ${id}\n`);
				break;
			}
			case 'delete': {
				const id = cmdArgs[0];
				if (!id) throw new Error('delete requires <id>');
				await store.delete(id);
				process.stdout.write(`Deleted ${id}\n`);
				break;
			}
			default:
				throw new Error(`Unknown command: ${cmd}\n\n${usage()}`);
		}
	}
} catch (error) {
	process.stderr.write(`${error?.message ?? String(error)}\n`);
	exitCode = 1;
}

process.exitCode = exitCode;
