#!/usr/bin/env node

import { main } from '../src/app.mjs';

main(process.argv.slice(2), {
	cwd: process.cwd(),
	env: process.env,
	stdin: process.stdin,
	stderr: process.stderr,
	stdout: process.stdout,
})
	.then((result) => {
		if (result?.ok === false) {
			process.exitCode = 1;
		}
	})
	.catch((error) => {
		process.stderr.write(`${error.message}\n`);
		process.exitCode = 1;
	});
