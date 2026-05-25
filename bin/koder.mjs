#!/usr/bin/env node

import { main } from '../src/app.mjs';

main(process.argv.slice(2), {
	cwd: process.cwd(),
	env: process.env,
	stderr: process.stderr,
	stdout: process.stdout,
}).catch((error) => {
	process.stderr.write(`${error.message}\n`);
	process.exitCode = 1;
});
