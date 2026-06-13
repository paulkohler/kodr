import assert from 'node:assert/strict';
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import {
	captureEnvironmentFacts,
	renderBehavioursBlock,
	renderEnvironmentBlock,
	renderToolsBlock,
} from '../src/system-env.mjs';
import {
	buildWorkspaceContext,
	renderPromptSections,
} from '../src/context-packer.mjs';

// ---------------------------------------------------------------------------
// renderEnvironmentBlock — unit tests
// ---------------------------------------------------------------------------

describe('renderEnvironmentBlock', () => {
	it('renders expected keys for a git repo', () => {
		const facts = {
			cwd: '/workspace/project',
			date: '2026-06-12',
			gitBranch: 'main',
			gitRepo: true,
			model: 'openai/gpt-oss-20b',
			nodeVersion: 'v24.16.0',
			osRelease: 'Darwin 25.5.0',
			platform: 'darwin',
			shell: 'zsh',
		};
		const block = renderEnvironmentBlock(facts);
		assert.match(block, /^# Environment/u);
		assert.match(block, /cwd: \/workspace\/project/u);
		assert.match(block, /git repository: yes \(branch main\)/u);
		assert.match(block, /platform: darwin \(Darwin 25\.5\.0\), shell: zsh/u);
		assert.match(block, /node: v24\.16\.0/u);
		assert.match(block, /date: 2026-06-12/u);
		assert.match(block, /model: openai\/gpt-oss-20b/u);
	});

	it('renders "no" for non-git directories', () => {
		const facts = {
			cwd: '/tmp/scratch',
			date: '2026-06-12',
			gitBranch: null,
			gitRepo: false,
			model: '',
			nodeVersion: 'v24.0.0',
			osRelease: 'Linux 6.1',
			platform: 'linux',
			shell: 'bash',
		};
		const block = renderEnvironmentBlock(facts);
		assert.match(block, /git repository: no/u);
		// model line is omitted when empty
		assert.doesNotMatch(block, /model:/u);
	});

	it('is byte-stable when called twice with the same facts', () => {
		const facts = {
			cwd: '/home/user/project',
			date: '2026-01-01',
			gitBranch: 'dev',
			gitRepo: true,
			model: 'qwen/qwen3.6-35b',
			nodeVersion: 'v24.1.0',
			osRelease: 'Linux 6.8',
			platform: 'linux',
			shell: 'zsh',
		};
		assert.equal(renderEnvironmentBlock(facts), renderEnvironmentBlock(facts));
	});

	it('includes "unknown" branch when branch is null in a repo', () => {
		const facts = {
			cwd: '/repo',
			date: '2026-06-12',
			gitBranch: null,
			gitRepo: true,
			model: '',
			nodeVersion: 'v24.0.0',
			osRelease: 'Linux 6.0',
			platform: 'linux',
			shell: 'sh',
		};
		const block = renderEnvironmentBlock(facts);
		assert.match(block, /git repository: yes \(branch unknown\)/u);
	});
});

// ---------------------------------------------------------------------------
// captureEnvironmentFacts — live integration (cheap — uses process globals)
// ---------------------------------------------------------------------------

describe('captureEnvironmentFacts', () => {
	it('captures real facts with expected shape', async () => {
		const tmp = await mkdtemp(join(tmpdir(), 'kodr-env-'));
		const facts = await captureEnvironmentFacts(tmp, { model: 'test/model' });

		assert.equal(typeof facts.cwd, 'string');
		assert.equal(typeof facts.date, 'string');
		assert.match(facts.date, /^\d{4}-\d{2}-\d{2}$/u);
		assert.equal(typeof facts.gitRepo, 'boolean');
		assert.equal(typeof facts.nodeVersion, 'string');
		assert.match(facts.nodeVersion, /^v\d+\.\d+/u);
		assert.equal(typeof facts.platform, 'string');
		assert.equal(typeof facts.osRelease, 'string');
		assert.equal(typeof facts.shell, 'string');
		assert.equal(facts.model, 'test/model');
	});

	it('byte-stable across two calls in the same session', async () => {
		const tmp = await mkdtemp(join(tmpdir(), 'kodr-env-'));
		const f1 = await captureEnvironmentFacts(tmp, { model: 'm' });
		const f2 = await captureEnvironmentFacts(tmp, { model: 'm' });
		// Date, cwd, node version, platform are all deterministic within a run.
		assert.equal(renderEnvironmentBlock(f1), renderEnvironmentBlock(f2));
	});
});

// ---------------------------------------------------------------------------
// renderBehavioursBlock / renderToolsBlock — structure checks
// ---------------------------------------------------------------------------

describe('renderBehavioursBlock', () => {
	it('starts with # Behaviours and has four lines', () => {
		const block = renderBehavioursBlock();
		assert.match(block, /^# Behaviours/u);
		const lines = block.split('\n').filter((l) => l.startsWith('-'));
		assert.equal(lines.length, 4, 'expected 4 behaviour lines');
	});

	it('contains the four expected directive keywords', () => {
		const block = renderBehavioursBlock();
		assert.match(block, /ONE JSON envelope/u);
		assert.match(block, /claim success/u);
		assert.match(block, /repeat the identical call/u);
		assert.match(block, /write it/u);
	});
});

describe('renderToolsBlock', () => {
	// Phase 117 (W1/W5): now lists eight tools including write_file and edit_file.
	it('starts with # Tools and lists all eight tools', () => {
		const block = renderToolsBlock();
		assert.match(block, /^# Tools/u);
		assert.match(block, /inspect_symbols/u);
		assert.match(block, /find_references/u);
		assert.match(block, /read_file/u);
		assert.match(block, /read_skill_resource/u);
		assert.match(block, /run_skill_command/u);
		assert.match(block, /run_command/u);
		assert.match(block, /write_file/u);
		assert.match(block, /edit_file/u);
	});

	it('contains positive capture-tool contract and budget reminder', () => {
		const block = renderToolsBlock();
		// Phase 117 (W5): positive contract replaces the "no write tool" prohibition.
		assert.match(block, /write_file or edit_file/u);
		assert.match(block, /limited number of tool turns/u);
	});
});

// ---------------------------------------------------------------------------
// Prompt assembly — sections present/absent by mode, order, budget guard
// ---------------------------------------------------------------------------

describe('prompt assembly with environment facts', () => {
	it('stable section includes # Behaviours in non-tools mode', () => {
		const sections = renderPromptSections({
			editFormat: 'patch',
			environmentFacts: null,
			toolsMode: false,
		});
		assert.match(sections.stable, /You are Kodr/u);
		assert.match(sections.stable, /# Behaviours/u);
		assert.doesNotMatch(sections.stable, /# Tools/u);
	});

	it('stable section includes # Tools in tools mode', () => {
		const sections = renderPromptSections({
			editFormat: 'patch',
			environmentFacts: null,
			toolsMode: true,
		});
		assert.match(sections.stable, /# Tools/u);
		assert.match(sections.stable, /inspect_symbols/u);
	});

	it('# Tools is absent from stable when toolsMode is false', () => {
		const sections = renderPromptSections({
			editFormat: 'patch',
			environmentFacts: null,
			toolsMode: false,
		});
		assert.doesNotMatch(sections.stable, /# Tools/u);
		assert.doesNotMatch(sections.stable, /inspect_symbols/u);
	});

	it('environment section is populated when environmentFacts provided', () => {
		const facts = {
			cwd: '/test/cwd',
			date: '2026-06-12',
			gitBranch: 'main',
			gitRepo: true,
			model: 'test-model',
			nodeVersion: 'v24.0.0',
			osRelease: 'Linux 6.0',
			platform: 'linux',
			shell: 'zsh',
		};
		const sections = renderPromptSections({ environmentFacts: facts });
		assert.match(sections.environment, /# Environment/u);
		assert.match(sections.environment, /cwd: \/test\/cwd/u);
		assert.match(sections.environment, /model: test-model/u);
	});

	it('environment section is empty string when no facts provided', () => {
		const sections = renderPromptSections({});
		assert.equal(sections.environment, '');
	});

	it('system prompt section order is stable-env-project-semiStable-volatile', async () => {
		const cwd = await mkWorkspace({
			'AGENTS.md': 'Test project instructions.',
			'app.mjs': 'export {};',
		});
		const facts = {
			cwd,
			date: '2026-06-12',
			gitBranch: null,
			gitRepo: false,
			model: 'test',
			nodeVersion: 'v24.0.0',
			osRelease: 'Test 1.0',
			platform: 'linux',
			shell: 'sh',
		};
		const context = await buildWorkspaceContext(cwd, {
			environmentFacts: facts,
		});
		const prompt = context.systemPrompt;
		const behaviourPos = prompt.indexOf('# Behaviours');
		const envPos = prompt.indexOf('# Environment');
		const agentsPos = prompt.indexOf('workspace-instructions');
		const workspacePos = prompt.indexOf('Workspace');

		assert.ok(
			behaviourPos < envPos,
			'# Behaviours should come before # Environment',
		);
		assert.ok(
			envPos < agentsPos,
			'# Environment should come before workspace instructions',
		);
		assert.ok(
			agentsPos < workspacePos,
			'workspace instructions should come before file listing',
		);
	});

	it('stableHash is identical with and without environment facts', () => {
		// The stable section does not include environment facts, so its hash
		// must be the same regardless of whether environmentFacts are provided.
		const withFacts = renderPromptSections({
			editFormat: 'patch',
			environmentFacts: {
				cwd: '/a',
				date: '2026-01-01',
				gitBranch: 'main',
				gitRepo: true,
				model: 'm',
				nodeVersion: 'v24',
				osRelease: 'OS 1',
				platform: 'linux',
				shell: 'sh',
			},
			toolsMode: false,
		});
		const withoutFacts = renderPromptSections({
			editFormat: 'patch',
			environmentFacts: null,
			toolsMode: false,
		});
		assert.equal(withFacts.stable, withoutFacts.stable);
	});
});

// ---------------------------------------------------------------------------
// Prompt budget guard — standard greenfield task must stay under ~2900 chars
// ---------------------------------------------------------------------------

describe('prompt budget guard', () => {
	// Phase 117 (W5): two new tool lines (write_file, edit_file) add ~220 chars.
	// Budget deliberately updated from 2900 → 3200. Stable section grew from two
	// to four tool-description lines; still well below the 4096-token LM Studio limit.
	it('standard greenfield system message stays under 3200 chars', async () => {
		const cwd = await mkWorkspace({
			'app.mjs': 'export function add(a, b) { return a + b; }',
		});
		const facts = {
			cwd,
			date: '2026-06-12',
			gitBranch: 'main',
			gitRepo: true,
			model: 'google/gemma-4-26b-a4b',
			nodeVersion: 'v24.16.0',
			osRelease: 'Darwin 25.5.0',
			platform: 'darwin',
			shell: 'zsh',
		};
		// Standard greenfield: tools mode (most expensive), patch format, one file.
		const context = await buildWorkspaceContext(cwd, {
			environmentFacts: facts,
			toolsMode: true,
		});
		const promptLen = context.systemPrompt.length;
		assert.ok(
			promptLen < 3200,
			`System message must stay under 3200 chars for a greenfield task; got ${promptLen} chars`,
		);
	});
});

// ---------------------------------------------------------------------------
// Helper
// ---------------------------------------------------------------------------

async function mkWorkspace(files) {
	const cwd = await mkdtemp(join(tmpdir(), 'kodr-sysenv-'));
	for (const [path, content] of Object.entries(files)) {
		const absolute = join(cwd, path);
		await mkdir(join(absolute, '..'), { recursive: true });
		await writeFile(absolute, content);
	}
	return cwd;
}
