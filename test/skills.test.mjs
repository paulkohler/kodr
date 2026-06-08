import assert from 'node:assert/strict';
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import {
	discoverSkills,
	loadSkillResource,
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

	it('parses skill resource metadata without loading resource bodies', () => {
		const skill = parseSkillMarkdown(
			'skills/editor/SKILL.md',
			[
				'---',
				'name: editor',
				'description: Edit files',
				'resources:',
				'  - path: docs/patches.md',
				'    description: Patch examples',
				'  - templates/review.md',
				'---',
				'Use patches.',
			].join('\n'),
		);

		assert.deepEqual(skill.resources, [
			{
				description: 'Patch examples',
				load: 'manual',
				path: 'docs/patches.md',
			},
			{ description: '', load: 'manual', path: 'templates/review.md' },
		]);
		assert.match(renderSkillIndex([skill]), /docs\/patches\.md \(manual\)/u);
		assert.doesNotMatch(renderSkillIndex([skill]), /Use patches/u);
	});

	it('parses skill command metadata without exposing script bodies', () => {
		const skill = parseSkillMarkdown(
			'skills/tools/SKILL.md',
			[
				'---',
				'name: tools',
				'commands:',
				'  - name: summarize',
				'    path: scripts/summarize.mjs',
				'    description: Summarize project data',
				'    args: --json',
				'---',
				'Use helpers only when asked.',
			].join('\n'),
		);

		assert.deepEqual(skill.commands, [
			{
				args: ['--json'],
				bin: '',
				description: 'Summarize project data',
				name: 'summarize',
				path: 'scripts/summarize.mjs',
				timeoutMs: 0,
			},
		]);
		assert.match(
			renderSkillIndex([skill]),
			/summarize -> scripts\/summarize\.mjs/u,
		);
		assert.doesNotMatch(renderSkillIndex([skill]), /Use helpers/u);
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

	it('loads declared skill resources with a skill-directory jail', async () => {
		const cwd = await mkWorkspace({
			'skills/edit/SKILL.md': [
				'---',
				'name: editor',
				'resources:',
				'  - path: docs/patches.md',
				'    description: Patch examples',
				'---',
				'Use patches.',
			].join('\n'),
			'skills/edit/docs/patches.md': 'patch reference body',
		});

		const resource = await loadSkillResource(cwd, 'editor', 'docs/patches.md');

		assert.equal(resource.skill, 'editor');
		assert.equal(resource.description, 'Patch examples');
		assert.equal(resource.path, 'docs/patches.md');
		assert.equal(resource.content, 'patch reference body');
	});

	it('rejects missing undeclared and escaping skill resources', async () => {
		const cwd = await mkWorkspace({
			'outside.md': 'secret',
			'skills/edit/SKILL.md': [
				'---',
				'name: editor',
				'resources:',
				'  - path: docs/missing.md',
				'  - path: ../outside.md',
				'---',
				'Use patches.',
			].join('\n'),
		});

		await assert.rejects(
			() => loadSkillResource(cwd, 'editor', 'templates/undeclared.md'),
			/Skill resource not declared/u,
		);
		await assert.rejects(
			() => loadSkillResource(cwd, 'editor', 'docs/missing.md'),
			/Skill resource not found/u,
		);
		await assert.rejects(
			() => loadSkillResource(cwd, 'editor', '../outside.md'),
			/escapes skill directory/u,
		);
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
	const cwd = await mkdtemp(join(tmpdir(), 'kodr-skills-'));

	for (const [path, content] of Object.entries(files)) {
		const absolute = join(cwd, path);
		await mkdir(join(absolute, '..'), { recursive: true });
		await writeFile(absolute, content, 'utf8');
	}

	return cwd;
}
