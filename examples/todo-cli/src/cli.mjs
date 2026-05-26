import { TodoStore } from './store.mjs';

const args = process.argv.slice(2);
if (args.length === 0 || args[0] === '--help') {
	console.log(`Usage:
  todo add <text> [--file path]
  todo list [--file path]
  todo done <id> [--file path]
  todo delete <id> [--file path]`);
	process.exit(0);
}

const command = args[0];
let filePath = 'todos.json';
const commandArgs = [];

for (let index = 1; index < args.length; index += 1) {
	if (args[index] === '--file') {
		filePath = args[index + 1];
		index += 1;
	} else {
		commandArgs.push(args[index]);
	}
}

try {
	if (command === 'add') {
		const todo = await TodoStore.add(filePath, commandArgs.join(' '));
		console.log(`Added #${todo.id}`);
	} else if (command === 'list') {
		const todos = await TodoStore.list(filePath);
		for (const todo of todos) {
			const mark = todo.done ? 'x' : ' ';
			console.log(`${todo.id}. [${mark}] ${todo.text}`);
		}
	} else if (command === 'done') {
		const todo = await TodoStore.done(filePath, commandArgs[0]);
		console.log(`Done #${todo.id}`);
	} else if (command === 'delete') {
		const todo = await TodoStore.delete(filePath, commandArgs[0]);
		console.log(`Deleted #${todo.id}`);
	} else {
		throw new Error(`Unknown command: ${command}`);
	}
} catch (error) {
	console.error(error.message);
	process.exitCode = 1;
}
