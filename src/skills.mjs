import { open } from 'node:fs/promises';
import { dirname } from 'node:path';
import { listContextFiles } from './context-packer.mjs';

export const DEFAULT_SKILL_BYTES = 12000;
export const DEFAULT_TOTAL_SKILL_BYTES = 40000;

export class SkillError extends Error {
	constructor(message) {
		super(message);
		this.name = 'SkillError';
	}
}

export async function discoverSkills(cwd, options = {}) {
	const perSkillBytes = options.perSkillBytes || DEFAULT_SKILL_BYTES;
	const totalSkillBytes = options.totalSkillBytes || DEFAULT_TOTAL_SKILL_BYTES;
	const files = await listContextFiles(cwd);
	const skillPaths = files.filter(
		(file) => file.endsWith('/SKILL.md') || file === 'SKILL.md',
	);
	const skills = [];
	let usedBytes = 0;

	for (const path of skillPaths) {
		if (usedBytes >= totalSkillBytes) {
			break;
		}

		const maxBytes = Math.min(perSkillBytes, totalSkillBytes - usedBytes);
		const loaded = await readSkillPrefix(`${cwd}/${path}`, maxBytes);
		const parsed = parseSkillMarkdown(path, loaded.raw);
		parsed.includedBytes = loaded.includedBytes;
		parsed.truncated = loaded.truncated;
		usedBytes += loaded.includedBytes;
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
		includedBytes: Buffer.byteLength(raw),
		name: parsed.frontmatter.name || fallbackName,
		path,
		truncated: false,
	};
}

export async function loadSkills(cwd, requests, options = {}) {
	const skills = await discoverSkills(cwd, options);
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
			const truncated = skill.truncated ? ' truncated="true"' : '';
			return `<skill name="${escapeAttribute(skill.name)}" path="${escapeAttribute(skill.path)}"${truncated}>\n${skill.body}\n</skill>`;
		})
		.join('\n\n');
}

async function readSkillPrefix(path, maxBytes) {
	const file = await open(path, 'r');
	try {
		const buffer = Buffer.alloc(maxBytes + 1);
		const { bytesRead } = await file.read(buffer, 0, maxBytes + 1, 0);
		const truncated = bytesRead > maxBytes;
		const prefix = buffer.subarray(0, Math.min(bytesRead, maxBytes));
		return {
			includedBytes: prefix.length,
			raw: prefix.toString('utf8'),
			truncated,
		};
	} finally {
		await file.close();
	}
}

function escapeAttribute(value) {
	return value.replaceAll('&', '&amp;').replaceAll('"', '&quot;');
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
