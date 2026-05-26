import { readFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { listContextFiles } from './context-packer.mjs';

export class SkillError extends Error {
	constructor(message) {
		super(message);
		this.name = 'SkillError';
	}
}

export async function discoverSkills(cwd) {
	const files = await listContextFiles(cwd);
	const skillPaths = files.filter(
		(file) => file.endsWith('/SKILL.md') || file === 'SKILL.md',
	);
	const skills = [];

	for (const path of skillPaths) {
		const raw = await readFile(`${cwd}/${path}`, 'utf8');
		const parsed = parseSkillMarkdown(path, raw);
		skills.push(parsed);
	}

	return skills.sort((left, right) => left.path.localeCompare(right.path));
}

export function parseSkillMarkdown(path, raw) {
	const parsed = parseFrontmatter(raw);
	const fallbackName = dirname(path).split('/').pop() || 'root';

	return {
		body: parsed.body,
		description: parsed.frontmatter.description || '',
		frontmatter: parsed.frontmatter,
		name: parsed.frontmatter.name || fallbackName,
		path,
	};
}

export async function loadSkills(cwd, requests) {
	const skills = await discoverSkills(cwd);
	const loaded = [];

	for (const request of requests) {
		const matches = skills.filter((skill) => {
			return skill.name === request || skill.path === request;
		});

		if (matches.length === 0) {
			throw new SkillError(`No SKILL.md matched: ${request}`);
		}

		if (matches.length > 1) {
			throw new SkillError(`Multiple SKILL.md files matched: ${request}`);
		}

		loaded.push(matches[0]);
	}

	return {
		index: skills.map(({ body, ...skill }) => skill),
		loaded,
	};
}

export function renderSkillIndex(skills) {
	if (skills.length === 0) {
		return 'No Markdown skills discovered.\n';
	}

	return `${skills
		.map((skill) => {
			const description = skill.description ? ` - ${skill.description}` : '';
			return `- ${skill.name} (${skill.path})${description}`;
		})
		.join('\n')}\n`;
}

export function renderLoadedSkills(skills) {
	if (skills.length === 0) {
		return '';
	}

	return skills
		.map((skill) => {
			return `## Skill: ${skill.name}\nPath: ${skill.path}\n\n${skill.body}`;
		})
		.join('\n\n');
}

function parseFrontmatter(raw) {
	if (!raw.startsWith('---\n')) {
		return {
			body: raw,
			frontmatter: {},
		};
	}

	const end = raw.indexOf('\n---', 4);
	if (end === -1) {
		return {
			body: raw,
			frontmatter: {},
		};
	}

	return {
		body: raw.slice(end + 4).replace(/^\n/u, ''),
		frontmatter: parseYamlSubset(raw.slice(4, end)),
	};
}

function parseYamlSubset(text) {
	const data = {};

	for (const line of text.split('\n')) {
		const trimmed = line.trim();
		if (!trimmed || trimmed.startsWith('#')) {
			continue;
		}

		const separator = trimmed.indexOf(':');
		if (separator === -1) {
			continue;
		}

		const key = trimmed.slice(0, separator).trim();
		const value = trimmed.slice(separator + 1).trim();
		data[key] = unquote(value);
	}

	return data;
}

function unquote(value) {
	if (
		(value.startsWith('"') && value.endsWith('"')) ||
		(value.startsWith("'") && value.endsWith("'"))
	) {
		return value.slice(1, -1);
	}

	return value;
}
