#!/usr/bin/env node
import { readFile, readdir, writeFile } from 'node:fs/promises';
import { join, relative } from 'node:path';
import { parseSkillMarkdown } from '../src/skills.mjs';

const root = process.cwd();
const skillsDir = join(root, 'src', 'builtin-skills');
const outputPath = join(root, 'src', 'builtin-skills.json');

async function findSkillFiles(dir) {
	const entries = await readdir(dir, { recursive: true, withFileTypes: true });
	return entries
		.filter((entry) => entry.isFile() && entry.name === 'SKILL.md')
		.map((entry) => join(entry.parentPath, entry.name))
		.sort();
}

async function buildBundle() {
	const paths = await findSkillFiles(skillsDir);
	const skills = [];
	for (const absPath of paths) {
		const rel = relative(skillsDir, absPath).replaceAll('\\', '/');
		const bundlePath = `builtin/${rel}`;
		const raw = await readFile(absPath, 'utf8');
		const parsed = parseSkillMarkdown(bundlePath, raw);
		skills.push({
			body: parsed.body,
			builtin: true,
			commands: parsed.commands,
			description: parsed.description,
			name: parsed.name,
			path: bundlePath,
			resources: parsed.resources,
		});
	}
	return skills.sort((left, right) => left.path.localeCompare(right.path));
}

const bundle = await buildBundle();
const json = `${JSON.stringify(bundle, null, '\t')}\n`;

if (process.argv.includes('--check')) {
	const existing = await readFile(outputPath, 'utf8').catch(() => '');
	if (existing !== json) {
		console.error(
			'src/builtin-skills.json is out of date. Run: npm run build-skills',
		);
		process.exitCode = 1;
	}
} else {
	await writeFile(outputPath, json, 'utf8');
	console.log(
		`Wrote ${bundle.length} built-in skills to src/builtin-skills.json`,
	);
}
