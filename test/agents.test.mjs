import assert from 'node:assert/strict';
import { mkdir, mkdtemp, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import {
	discoverAgents,
	findAgent,
	AgentError,
	isOrchestrationRole,
	parseAgentMarkdown,
} from '../src/agents.mjs';
import {
	discoverSkillsTiered,
	SKILL_TIERS,
	discoverSkills,
	loadSkills,
} from '../src/skills.mjs';

// ── helpers ──────────────────────────────────────────────────────────────────

async function mkWorkspace(files) {
	const cwd = await mkdtemp(join(tmpdir(), 'kodr-116-'));
	for (const [path, content] of Object.entries(files)) {
		const abs = join(cwd, path);
		await mkdir(join(abs, '..'), { recursive: true });
		await writeFile(abs, content, 'utf8');
	}
	return cwd;
}

// ── K1: SKILL_TIERS export ───────────────────────────────────────────────────

describe('SKILL_TIERS', () => {
	it('exports the ordered tier array', () => {
		assert.deepEqual(SKILL_TIERS, ['override', 'workspace', 'project', 'user']);
	});
});

// ── K1: tiered skill discovery ───────────────────────────────────────────────

describe('discoverSkillsTiered', () => {
	it('workspace tier picks up SKILL.md files', async () => {
		const cwd = await mkWorkspace({
			'a/SKILL.md': '---\nname: alpha\ndescription: Alpha\n---\nbody A',
			'b/SKILL.md': '---\nname: beta\n---\nbody B',
		});

		const { skills, shadows } = await discoverSkillsTiered(cwd, {
			homeDir: cwd, // no real user skills
		});

		assert.equal(shadows.length, 0);
		const names = skills.map((s) => s.name);
		assert.ok(names.includes('alpha'), 'alpha found');
		assert.ok(names.includes('beta'), 'beta found');
		for (const skill of skills) {
			assert.equal(skill.tier, 'workspace');
		}
	});

	it('override dir beats workspace for same name', async () => {
		const overrideDir = await mkdtemp(join(tmpdir(), 'kodr-override-'));
		await mkdir(join(overrideDir, 'alpha'), { recursive: true });
		await writeFile(
			join(overrideDir, 'alpha', 'SKILL.md'),
			'---\nname: alpha\ndescription: Override Alpha\n---\nOverride body',
			'utf8',
		);

		const cwd = await mkWorkspace({
			'a/SKILL.md':
				'---\nname: alpha\ndescription: Workspace Alpha\n---\nWorkspace body',
		});

		const { skills, shadows } = await discoverSkillsTiered(cwd, {
			homeDir: cwd,
			skillsDirs: [overrideDir],
		});

		const alpha = skills.find((s) => s.name === 'alpha');
		assert.ok(alpha, 'alpha found');
		assert.equal(alpha.tier, 'override');
		assert.equal(alpha.description, 'Override Alpha');

		assert.equal(shadows.length, 1);
		assert.equal(shadows[0].name, 'alpha');
		assert.equal(shadows[0].winnerTier, 'override');
		assert.equal(shadows[0].shadowTier, 'workspace');
	});

	it('project dot-folder skills discovered from .claude/skills', async () => {
		// Use a separate dir for cwd so .claude/skills is NOT in the workspace tree
		const cwd = await mkdtemp(join(tmpdir(), 'kodr-cwd-'));
		const projectSkillsDir = join(cwd, '.claude', 'skills');
		await mkdir(join(projectSkillsDir, 'myfoo'), { recursive: true });
		await writeFile(
			join(projectSkillsDir, 'myfoo', 'SKILL.md'),
			'---\nname: myfoo\ndescription: Project foo\n---\nfoo body',
			'utf8',
		);

		const { skills } = await discoverSkillsTiered(cwd, {
			homeDir: cwd, // no user-level skills (cwd has no ~/.claude/skills)
		});

		const foo = skills.find((s) => s.name === 'myfoo');
		assert.ok(foo, 'myfoo found');
		// .claude/skills IS in cwd, so workspace scan picks it up FIRST (tier=workspace)
		// OR project scan gets it (tier=project). Either way it's discovered.
		assert.ok(
			foo.tier === 'workspace' || foo.tier === 'project',
			`expected workspace or project tier, got ${foo.tier}`,
		);
	});

	it('user dot-folder skills discovered from homeDir/.claude/skills', async () => {
		const fakeHome = await mkdtemp(join(tmpdir(), 'kodr-home-'));
		await mkdir(join(fakeHome, '.claude', 'skills', 'userbar'), {
			recursive: true,
		});
		await writeFile(
			join(fakeHome, '.claude', 'skills', 'userbar', 'SKILL.md'),
			'---\nname: userbar\ndescription: User bar\n---\nbar body',
			'utf8',
		);

		const cwd = await mkdtemp(join(tmpdir(), 'kodr-cwd-'));

		const { skills } = await discoverSkillsTiered(cwd, {
			homeDir: fakeHome,
		});

		const bar = skills.find((s) => s.name === 'userbar');
		assert.ok(bar, 'userbar found');
		assert.equal(bar.tier, 'user');
	});

	it('Claude Code SKILL.md (name/description only) parses correctly', async () => {
		const fakeHome = await mkdtemp(join(tmpdir(), 'kodr-home-'));
		await mkdir(join(fakeHome, '.claude', 'skills', 'find-skills'), {
			recursive: true,
		});
		await writeFile(
			join(fakeHome, '.claude', 'skills', 'find-skills', 'SKILL.md'),
			'---\nname: find-skills\ndescription: Helps users discover and install skills\n---\n# Body content here',
			'utf8',
		);

		const cwd = await mkdtemp(join(tmpdir(), 'kodr-cwd-'));
		const { skills } = await discoverSkillsTiered(cwd, { homeDir: fakeHome });

		const s = skills.find((s) => s.name === 'find-skills');
		assert.ok(s, 'find-skills found');
		assert.equal(s.description, 'Helps users discover and install skills');
		assert.equal(s.commands.length, 0, 'no commands key');
		assert.equal(s.resources.length, 0, 'no resources key');
		assert.equal(s.body, '# Body content here');
	});

	it('shadow records both paths when same name appears in two tiers', async () => {
		const fakeHome = await mkdtemp(join(tmpdir(), 'kodr-home-'));
		await mkdir(join(fakeHome, '.claude', 'skills', 'shared'), {
			recursive: true,
		});
		await writeFile(
			join(fakeHome, '.claude', 'skills', 'shared', 'SKILL.md'),
			'---\nname: shared\n---\nuser copy',
			'utf8',
		);

		const cwd = await mkWorkspace({
			'x/SKILL.md': '---\nname: shared\n---\nworkspace copy',
		});

		const { skills, shadows } = await discoverSkillsTiered(cwd, {
			homeDir: fakeHome,
		});

		// workspace wins over user
		const s = skills.find((s) => s.name === 'shared');
		assert.ok(s);
		assert.equal(s.tier, 'workspace');

		assert.equal(shadows.length, 1);
		assert.equal(shadows[0].winnerTier, 'workspace');
		assert.equal(shadows[0].shadowTier, 'user');
	});

	it('missing dirs are skipped silently', async () => {
		const cwd = await mkdtemp(join(tmpdir(), 'kodr-empty-'));
		const fakeHome = await mkdtemp(join(tmpdir(), 'kodr-home-'));

		// No files at all; no dot-folders exist
		const { skills, shadows } = await discoverSkillsTiered(cwd, {
			homeDir: fakeHome,
		});

		assert.equal(skills.length, 0);
		assert.equal(shadows.length, 0);
	});

	it('skills carry absoluteRoot for jail use', async () => {
		const fakeHome = await mkdtemp(join(tmpdir(), 'kodr-home-'));
		await mkdir(join(fakeHome, '.kodr', 'skills', 'myz'), { recursive: true });
		await writeFile(
			join(fakeHome, '.kodr', 'skills', 'myz', 'SKILL.md'),
			'---\nname: myz\n---\nbody',
			'utf8',
		);

		const cwd = await mkdtemp(join(tmpdir(), 'kodr-cwd-'));
		const { skills } = await discoverSkillsTiered(cwd, { homeDir: fakeHome });

		const s = skills.find((sk) => sk.name === 'myz');
		assert.ok(s);
		assert.ok(
			s.absoluteRoot.endsWith('/myz'),
			`absoluteRoot should end with /myz, got: ${s.absoluteRoot}`,
		);
	});
});

// ── K2: agent file parsing ───────────────────────────────────────────────────

describe('parseAgentMarkdown', () => {
	it('parses full frontmatter: name, description, model', () => {
		const raw = [
			'---',
			'name: my-agent',
			'description: Does useful things',
			'model: sonnet',
			'---',
			'You are a helpful assistant.',
		].join('\n');

		const spec = parseAgentMarkdown(raw, '/agents/my-agent.md', 'project');
		assert.equal(spec.name, 'my-agent');
		assert.equal(spec.description, 'Does useful things');
		assert.equal(spec.rawModelSpec, 'sonnet');
		// 'sonnet' is a Claude Code alias — stored as modelAlias, not modelSpec
		assert.equal(spec.modelSpec, '');
		assert.equal(spec.modelAlias, 'sonnet');
		assert.equal(spec.body, 'You are a helpful assistant.');
		assert.equal(spec.tier, 'project');
	});

	it('fallback name from filename when frontmatter lacks name', () => {
		const raw = '---\ndescription: No name\n---\nBody here';
		const spec = parseAgentMarkdown(raw, '/agents/cool-agent.md', 'user');
		assert.equal(spec.name, 'cool-agent');
	});

	it('preserves unknown frontmatter keys', () => {
		const raw = '---\nname: x\nfoo: bar\nbaz: qux\n---\nbody';
		const spec = parseAgentMarkdown(raw, '/a.md', 'project');
		assert.equal(spec.frontmatter.foo, 'bar');
		assert.equal(spec.frontmatter.baz, 'qux');
	});

	it('model alias kept as metadata, not a provider spec', () => {
		// All Claude Code aliases must be stored as modelAlias, not modelSpec
		for (const alias of [
			'sonnet',
			'opus',
			'haiku',
			'fable',
			'inherit',
			'Sonnet',
			'OPUS',
		]) {
			const raw = `---\nname: x\nmodel: ${alias}\n---\nbody`;
			const spec = parseAgentMarkdown(raw, '/a.md', 'project');
			assert.equal(
				spec.rawModelSpec,
				alias,
				`rawModelSpec should equal input for alias ${alias}`,
			);
			assert.equal(
				spec.modelSpec,
				'',
				`modelSpec should be empty for alias ${alias}`,
			);
			assert.equal(
				spec.modelAlias,
				alias,
				`modelAlias should equal input for alias ${alias}`,
			);
		}
	});

	it('body is empty string when no body after frontmatter', () => {
		const raw = '---\nname: x\n---\n';
		const spec = parseAgentMarkdown(raw, '/a.md', 'project');
		assert.equal(spec.body, '');
	});

	it('parses files without frontmatter — uses filename as name', () => {
		const raw = 'Just a plain body with no frontmatter';
		const spec = parseAgentMarkdown(raw, '/agents/plain.md', 'project');
		assert.equal(spec.name, 'plain');
		assert.equal(spec.body, raw);
	});
});

// ── K2: agent discovery ──────────────────────────────────────────────────────

describe('discoverAgents', () => {
	it('discovers agents from .claude/agents in cwd', async () => {
		const fakeHome = await mkdtemp(join(tmpdir(), 'kodr-home-'));
		const cwd = await mkWorkspace({
			'.claude/agents/foo.md':
				'---\nname: foo\ndescription: Foo agent\n---\nFoo body',
			'.claude/agents/bar.md':
				'---\nname: bar\ndescription: Bar agent\n---\nBar body',
		});

		const { agents, shadows } = await discoverAgents(cwd, {
			homeDir: fakeHome,
		});

		assert.equal(shadows.length, 0);
		const names = agents.map((a) => a.name).sort();
		assert.deepEqual(names, ['bar', 'foo']);
		for (const a of agents) {
			assert.equal(a.tier, 'project');
		}
	});

	it('discovers agents from .kodr/agents in cwd', async () => {
		const cwd = await mkWorkspace({
			'.kodr/agents/baz.md': '---\nname: baz\n---\nBaz body',
		});

		const { agents } = await discoverAgents(cwd, { homeDir: cwd });
		const baz = agents.find((a) => a.name === 'baz');
		assert.ok(baz);
		assert.equal(baz.tier, 'project');
	});

	it('discovers user-level agents from homeDir/.claude/agents', async () => {
		const fakeHome = await mkdtemp(join(tmpdir(), 'kodr-home-'));
		await mkdir(join(fakeHome, '.claude', 'agents'), { recursive: true });
		await writeFile(
			join(fakeHome, '.claude', 'agents', 'user-agent.md'),
			'---\nname: user-agent\ndescription: From user dir\n---\nUser body',
			'utf8',
		);

		const cwd = await mkdtemp(join(tmpdir(), 'kodr-cwd-'));
		const { agents } = await discoverAgents(cwd, { homeDir: fakeHome });

		const ua = agents.find((a) => a.name === 'user-agent');
		assert.ok(ua);
		assert.equal(ua.tier, 'user');
	});

	it('project agent shadows user-level agent of same name', async () => {
		const fakeHome = await mkdtemp(join(tmpdir(), 'kodr-home-'));
		await mkdir(join(fakeHome, '.claude', 'agents'), { recursive: true });
		await writeFile(
			join(fakeHome, '.claude', 'agents', 'shared.md'),
			'---\nname: shared\n---\nUser copy',
			'utf8',
		);

		const cwd = await mkWorkspace({
			'.claude/agents/shared.md': '---\nname: shared\n---\nProject copy',
		});

		const { agents, shadows } = await discoverAgents(cwd, {
			homeDir: fakeHome,
		});

		const s = agents.find((a) => a.name === 'shared');
		assert.ok(s);
		assert.equal(s.tier, 'project');

		assert.equal(shadows.length, 1);
		assert.equal(shadows[0].winnerTier, 'project');
		assert.equal(shadows[0].shadowTier, 'user');
	});

	it('override dir takes highest precedence', async () => {
		const overrideDir = await mkdtemp(join(tmpdir(), 'kodr-override-'));
		await writeFile(
			join(overrideDir, 'shared.md'),
			'---\nname: shared\n---\nOverride copy',
			'utf8',
		);

		const fakeHome = await mkdtemp(join(tmpdir(), 'kodr-home-'));
		const cwd = await mkWorkspace({
			'.claude/agents/shared.md': '---\nname: shared\n---\nProject copy',
		});

		const { agents, shadows } = await discoverAgents(cwd, {
			homeDir: fakeHome,
			agentsDirs: [overrideDir],
		});

		const s = agents.find((a) => a.name === 'shared');
		assert.ok(s);
		assert.equal(s.tier, 'override');
		assert.equal(shadows.length, 1);
		assert.equal(shadows[0].winnerTier, 'override');
	});

	it('missing dirs are skipped silently', async () => {
		const cwd = await mkdtemp(join(tmpdir(), 'kodr-empty-'));
		const fakeHome = await mkdtemp(join(tmpdir(), 'kodr-home-'));
		const { agents, shadows } = await discoverAgents(cwd, {
			homeDir: fakeHome,
		});
		assert.equal(agents.length, 0);
		assert.equal(shadows.length, 0);
	});

	it('parses real kodr .claude/agents files without error', async () => {
		// Security-boundary check: parse the actual agent files in this repo.
		const repoAgentsDir = new URL('../.claude/agents/', import.meta.url)
			.pathname;
		const cwd = await mkdtemp(join(tmpdir(), 'kodr-real-'));

		const { agents } = await discoverAgents(cwd, {
			agentsDirs: [repoAgentsDir],
			homeDir: cwd,
		});

		assert.ok(agents.length >= 2, `expected >= 2 agents, got ${agents.length}`);
		const names = agents.map((a) => a.name);
		assert.ok(
			names.includes('kodr-phase-implementer'),
			'kodr-phase-implementer found',
		);
		assert.ok(names.includes('kodr-test-operator'), 'kodr-test-operator found');
		// Both agents declare model: sonnet
		for (const a of agents) {
			assert.equal(a.rawModelSpec, 'sonnet');
		}
	});
});

// ── K2: findAgent ────────────────────────────────────────────────────────────

describe('findAgent', () => {
	it('returns the matching agent by name', () => {
		const agents = [
			{ name: 'foo', body: 'Foo' },
			{ name: 'bar', body: 'Bar' },
		];
		const found = findAgent(agents, 'foo');
		assert.equal(found.name, 'foo');
	});

	it('throws AgentError with roster when not found', () => {
		const agents = [{ name: 'foo' }, { name: 'bar' }];
		assert.throws(
			() => findAgent(agents, 'missing'),
			(err) => {
				assert.ok(err instanceof AgentError);
				assert.match(err.message, /Unknown agent/u);
				assert.match(err.message, /foo/u);
				assert.match(err.message, /bar/u);
				return true;
			},
		);
	});

	it('throws AgentError when no agents available', () => {
		assert.throws(
			() => findAgent([], 'anything'),
			(err) => {
				assert.ok(err instanceof AgentError);
				assert.match(err.message, /\(none\)/u);
				return true;
			},
		);
	});
});

// ── K2: isOrchestrationRole ──────────────────────────────────────────────────

describe('isOrchestrationRole', () => {
	it('returns true for known orchestration role names', () => {
		assert.equal(isOrchestrationRole('planner'), true);
		assert.equal(isOrchestrationRole('implementer'), true);
		assert.equal(isOrchestrationRole('file-author'), true);
		assert.equal(isOrchestrationRole('reviewer'), true);
	});

	it('returns false for non-role names', () => {
		assert.equal(isOrchestrationRole('my-custom-agent'), false);
		assert.equal(isOrchestrationRole(''), false);
		assert.equal(isOrchestrationRole('Planner'), false);
	});
});

// ── K4: per-skill-root resource jail ────────────────────────────────────────

describe('skill resource jail for out-of-tree skills', () => {
	it('skill absoluteRoot is set for user-tier skills', async () => {
		const fakeHome = await mkdtemp(join(tmpdir(), 'kodr-home-'));
		await mkdir(join(fakeHome, '.claude', 'skills', 'myskill'), {
			recursive: true,
		});
		await writeFile(
			join(fakeHome, '.claude', 'skills', 'myskill', 'SKILL.md'),
			[
				'---',
				'name: myskill',
				'resources:',
				'  - path: data/info.md',
				'---',
				'Use data.',
			].join('\n'),
			'utf8',
		);
		await mkdir(join(fakeHome, '.claude', 'skills', 'myskill', 'data'), {
			recursive: true,
		});
		await writeFile(
			join(fakeHome, '.claude', 'skills', 'myskill', 'data', 'info.md'),
			'Resource content',
			'utf8',
		);

		const cwd = await mkdtemp(join(tmpdir(), 'kodr-cwd-'));
		const skills = await discoverSkills(cwd, {
			homeDir: fakeHome,
			skillsDirs: [join(fakeHome, '.claude', 'skills')],
		});

		const s = skills.find((sk) => sk.name === 'myskill');
		assert.ok(s, 'myskill found');
		// absoluteRoot should point to the skill dir under fakeHome, not under cwd
		assert.ok(
			s.absoluteRoot.startsWith(fakeHome),
			`absoluteRoot should be under fakeHome; got: ${s.absoluteRoot}`,
		);
	});
});

// ── BUG-116-01: symlinked skill directories are discovered ───────────────────

describe('scanDotFolderSkills follows symlinked directories (BUG-116-01)', () => {
	it('discovers a skill dir installed as a symlink', async () => {
		// Create a real skill directory tree elsewhere in tmp
		const realSkillsRoot = await mkdtemp(join(tmpdir(), 'kodr-real-skills-'));
		const realSkillDir = join(realSkillsRoot, 'linked-skill');
		await mkdir(realSkillDir, { recursive: true });
		await writeFile(
			join(realSkillDir, 'SKILL.md'),
			'---\nname: linked-skill\ndescription: Installed via symlink\n---\nSymlink skill body',
			'utf8',
		);

		// Create a skills dir where the skill entry is a symlink to the real dir
		const symlinkSkillsDir = await mkdtemp(join(tmpdir(), 'kodr-sym-skills-'));
		let symlinkCreated = true;
		try {
			await symlink(realSkillDir, join(symlinkSkillsDir, 'linked-skill'));
		} catch {
			symlinkCreated = false;
		}

		if (!symlinkCreated) {
			// Symlink creation failed (unusual on darwin/linux) — skip with note
			process.stdout.write(
				'# SKIP: symlink creation failed on this platform\n',
			);
			return;
		}

		const cwd = await mkdtemp(join(tmpdir(), 'kodr-cwd-'));
		const { skills } = await discoverSkillsTiered(cwd, {
			homeDir: cwd,
			skillsDirs: [symlinkSkillsDir],
		});

		const s = skills.find((sk) => sk.name === 'linked-skill');
		assert.ok(s, 'symlinked skill directory should be discovered');
		assert.equal(s.tier, 'override');
		assert.equal(s.description, 'Installed via symlink');
	});

	it('skips symlinks whose target is not a directory', async () => {
		// A symlink pointing to a file (not a dir) must be ignored
		const tmpRoot = await mkdtemp(join(tmpdir(), 'kodr-sym-file-'));
		const targetFile = join(tmpRoot, 'not-a-dir.txt');
		await writeFile(targetFile, 'hello', 'utf8');
		const symlinkSkillsDir = join(tmpRoot, 'skills-dir');
		await mkdir(symlinkSkillsDir, { recursive: true });
		let symlinkCreated = true;
		try {
			await symlink(targetFile, join(symlinkSkillsDir, 'bad-link'));
		} catch {
			symlinkCreated = false;
		}
		if (!symlinkCreated) {
			process.stdout.write(
				'# SKIP: symlink creation failed on this platform\n',
			);
			return;
		}

		const cwd = await mkdtemp(join(tmpdir(), 'kodr-cwd-'));
		const { skills } = await discoverSkillsTiered(cwd, {
			homeDir: cwd,
			skillsDirs: [symlinkSkillsDir],
		});
		// bad-link points to a file — must not appear as a skill
		assert.equal(
			skills.length,
			0,
			'file-symlink should not be treated as skill dir',
		);
	});
});

// ── BUG-116-02: Claude Code model aliases are never used as model specs ───────

describe('Claude Code model aliases treated as metadata (BUG-116-02)', () => {
	it('sonnet/opus/haiku/fable/inherit are stored as modelAlias, not modelSpec', () => {
		for (const alias of ['sonnet', 'opus', 'haiku', 'fable', 'inherit']) {
			const raw = `---\nname: a\nmodel: ${alias}\n---\nbody`;
			const spec = parseAgentMarkdown(raw, '/a.md', 'project');
			assert.equal(spec.modelSpec, '', `${alias}: modelSpec must be empty`);
			assert.equal(
				spec.modelAlias,
				alias,
				`${alias}: modelAlias must equal alias`,
			);
		}
	});

	it('case-insensitive: Sonnet and OPUS treated as aliases', () => {
		for (const alias of ['Sonnet', 'OPUS', 'Haiku']) {
			const raw = `---\nname: a\nmodel: ${alias}\n---\nbody`;
			const spec = parseAgentMarkdown(raw, '/a.md', 'project');
			assert.equal(spec.modelSpec, '', `${alias}: modelSpec must be empty`);
			assert.equal(spec.modelAlias, alias);
		}
	});

	it('real provider-prefixed model ids are still treated as model specs', () => {
		const ids = [
			'lmstudio/google/gemma-4-26b-a4b',
			'google/gemma-4-26b-a4b',
			'qwen/qwen3.6-35b-a3b',
			'ollama/llama3',
		];
		for (const id of ids) {
			const raw = `---\nname: a\nmodel: ${id}\n---\nbody`;
			const spec = parseAgentMarkdown(raw, '/a.md', 'project');
			assert.equal(spec.modelAlias, '', `${id}: modelAlias must be empty`);
			assert.equal(spec.modelSpec, id, `${id}: modelSpec must equal id`);
		}
	});

	it('when agent has alias and no --model, model is NOT set to the alias', async () => {
		// Simulate what app.mjs does: if agentSpec.modelAlias && !agentSpec.modelSpec
		// → warn and skip. The alias must never land in options.model.
		const raw = '---\nname: a\nmodel: sonnet\n---\nbody';
		const spec = parseAgentMarkdown(raw, '/a.md', 'project');

		// Mimic app.mjs agent resolution logic
		const options = { model: 'qwen/qwen3.6-35b-a3b', modelExplicit: false };
		if (spec.modelSpec && !options.modelExplicit) {
			options.model = spec.modelSpec; // should NOT happen
		}

		// options.model must NOT be 'sonnet'
		assert.notEqual(
			options.model,
			'sonnet',
			'sonnet alias must not propagate to options.model',
		);
		assert.equal(
			options.model,
			'qwen/qwen3.6-35b-a3b',
			'default model unchanged when agent uses alias',
		);
	});
});

// ── OBSERVATION-116-01: project dot-folder skill tier label ──────────────────

describe('project dot-folder skills report tier project (OBSERVATION-116-01)', () => {
	it('skill under .claude/skills/ in cwd gets tier project, not workspace', async () => {
		const cwd = await mkdtemp(join(tmpdir(), 'kodr-obs-'));
		const skillDir = join(cwd, '.claude', 'skills', 'proj-skill');
		await mkdir(skillDir, { recursive: true });
		await writeFile(
			join(skillDir, 'SKILL.md'),
			'---\nname: proj-skill\ndescription: Project tier skill\n---\nProject body',
			'utf8',
		);

		const fakeHome = await mkdtemp(join(tmpdir(), 'kodr-home-'));
		const { skills, shadows } = await discoverSkillsTiered(cwd, {
			homeDir: fakeHome,
		});

		const s = skills.find((sk) => sk.name === 'proj-skill');
		assert.ok(s, 'proj-skill found');
		assert.equal(
			s.tier,
			'project',
			'skill under .claude/skills/ should report tier project',
		);
		// No self-shadow: the skill should not shadow itself
		const selfShadow = shadows.find((sh) => sh.name === 'proj-skill');
		assert.ok(!selfShadow, 'no self-shadow for project dot-folder skill');
	});

	it('skill under .kodr/skills/ in cwd gets tier project, not workspace', async () => {
		const cwd = await mkdtemp(join(tmpdir(), 'kodr-obs2-'));
		const skillDir = join(cwd, '.kodr', 'skills', 'kodr-skill');
		await mkdir(skillDir, { recursive: true });
		await writeFile(
			join(skillDir, 'SKILL.md'),
			'---\nname: kodr-skill\ndescription: Kodr project skill\n---\nKodr body',
			'utf8',
		);

		const fakeHome = await mkdtemp(join(tmpdir(), 'kodr-home-'));
		const { skills, shadows } = await discoverSkillsTiered(cwd, {
			homeDir: fakeHome,
		});

		const s = skills.find((sk) => sk.name === 'kodr-skill');
		assert.ok(s, 'kodr-skill found');
		assert.equal(
			s.tier,
			'project',
			'skill under .kodr/skills/ should report tier project',
		);
		const selfShadow = shadows.find((sh) => sh.name === 'kodr-skill');
		assert.ok(!selfShadow, 'no self-shadow for .kodr/skills/ skill');
	});
});

// ── Budget exhaustion lists metadata-only skills (BUG-116-03) ────────────────

describe('budget exhaustion stops body inclusion, not enumeration', () => {
	it('skills past the total budget are listed metadata-only', async () => {
		const overrideDir = await mkdtemp(join(tmpdir(), 'kodr-budget-'));
		const body = 'B'.repeat(500);
		for (const name of ['aa', 'bb', 'cc']) {
			await mkdir(join(overrideDir, name), { recursive: true });
			await writeFile(
				join(overrideDir, name, 'SKILL.md'),
				`---\nname: ${name}\ndescription: Skill ${name}\n---\n${body}`,
				'utf8',
			);
		}
		const cwd = await mkdtemp(join(tmpdir(), 'kodr-cwd-'));

		const { skills } = await discoverSkillsTiered(cwd, {
			homeDir: cwd,
			skillsDirs: [overrideDir],
			totalSkillBytes: 700, // fits one full skill, exhausted before the rest
		});

		assert.deepEqual(
			skills.map((s) => s.name),
			['aa', 'bb', 'cc'],
			'all skills enumerated despite budget',
		);
		const omitted = skills.filter((s) => s.bodyOmitted);
		assert.ok(omitted.length >= 1, 'at least one skill is metadata-only');
		for (const skill of omitted) {
			assert.equal(skill.body, '');
			assert.equal(skill.includedBytes, 0);
			assert.equal(skill.truncated, true);
			assert.ok(skill.description.startsWith('Skill '), 'frontmatter kept');
		}
		const usedBytes = skills.reduce((sum, s) => sum + s.includedBytes, 0);
		assert.ok(usedBytes <= 700, 'budget invariant holds');
	});

	it('loadSkills reloads the body of a metadata-only skill on request', async () => {
		const overrideDir = await mkdtemp(join(tmpdir(), 'kodr-budget-'));
		const body = 'B'.repeat(500);
		for (const name of ['aa', 'bb']) {
			await mkdir(join(overrideDir, name), { recursive: true });
			await writeFile(
				join(overrideDir, name, 'SKILL.md'),
				`---\nname: ${name}\ndescription: Skill ${name}\n---\n${body}`,
				'utf8',
			);
		}
		const cwd = await mkdtemp(join(tmpdir(), 'kodr-cwd-'));

		const { loaded } = await loadSkills(cwd, ['bb'], {
			homeDir: cwd,
			skillsDirs: [overrideDir],
			totalSkillBytes: 400, // aa hits the cap exactly; bb is metadata-only
		});

		assert.equal(loaded.length, 1);
		assert.equal(loaded[0].name, 'bb');
		assert.equal(loaded[0].body, body, 'body reloaded on explicit request');
		assert.ok(!loaded[0].bodyOmitted, 'no longer metadata-only');
		assert.equal(loaded[0].tier, 'override');
	});
});
