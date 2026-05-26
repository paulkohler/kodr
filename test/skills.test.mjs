import assert from 'node:assert/strict';
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import {
	discoverSkills,
	loadSkills,
	parseSkillMarkdown,
	renderLoadedSkills,
	renderSkillIndex,
} from '../src/skills.mjs';

describe('Markdown skills', () => {
	it('discovers SKILL.md files deterministically', async () => {
		const cwd = await mkWorkspace({
			'a/SKILL.md': '---\nname: alpha\ndescription: Alpha skill\n---\nUse A.',
			'b/SKILL.md': '---\nname: beta\n---\nUse B.',
			'b/notes.md': 'ignored',
		});

		const skills = await discoverSkills(cwd);

		assert.deepEqual(
			skills.map((skill) => skill.path),
			['a/SKILL.md', 'b/SKILL.md'],
		);
		assert.deepEqual(
			skills.map((skill) => skill.name),
			['alpha', 'beta'],
		);
	});

	it('parses frontmatter with and without optional fields', () => {
		assert.deepEqual(
			parseSkillMarkdown('tool/SKILL.md', '# Skill').name,
			'tool',
		);

		const skill = parseSkillMarkdown(
			'nested/SKILL.md',
			'---\nname: custom\ndescription: "Useful text"\n---\n# Body',
		);

		assert.equal(skill.name, 'custom');
		assert.equal(skill.description, 'Useful text');
		assert.equal(skill.body, '# Body');
	});

	it('loads only requested Markdown skill bodies', async () => {
		const cwd = await mkWorkspace({
			'a/SKILL.md': '---\nname: alpha\ndescription: Alpha skill\n---\nUse A.',
			'b/SKILL.md': '---\nname: beta\ndescription: Beta skill\n---\nUse B.',
		});

		const result = await loadSkills(cwd, ['beta']);

		assert.deepEqual(
			result.index.map((skill) => skill.name),
			['alpha', 'beta'],
		);
		assert.deepEqual(
			result.loaded.map((skill) => skill.name),
			['beta'],
		);
		assert.equal(result.loaded[0].body, 'Use B.');
		assert.match(renderSkillIndex(result.index), /alpha/u);
		assert.match(renderSkillIndex(result.index), /beta/u);
	});

	it('caps skill bodies and marks loaded skills as untrusted blocks', async () => {
		const cwd = await mkWorkspace({
			'a/SKILL.md':
				'---\nname: alpha\ndescription: Alpha skill\n---\n1234567890',
			'b/SKILL.md': '---\nname: beta\ndescription: Beta skill\n---\nignored',
		});

		const result = await loadSkills(cwd, ['a/SKILL.md'], {
			perSkillBytes: 8,
			totalSkillBytes: 8,
		});

		assert.equal(result.index.length, 1);
		assert.equal(result.loaded[0].truncated, true);
		assert.equal(result.loaded[0].includedBytes, 8);
		assert.match(renderLoadedSkills(result.loaded), /<skill name="a"/u);
		assert.match(renderLoadedSkills(result.loaded), /truncated="true"/u);
		assert.match(renderLoadedSkills(result.loaded), /<\/skill>/u);
	});
});

async function mkWorkspace(files) {
	const cwd = await mkdtemp(join(tmpdir(), 'koder-skills-'));

	for (const [path, content] of Object.entries(files)) {
		const absolute = join(cwd, path);
		await mkdir(join(absolute, '..'), { recursive: true });
		await writeFile(absolute, content, 'utf8');
	}

	return cwd;
}
