import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import {
	runSkillCommand,
	SkillExecutionError,
} from '../src/skill-execution.mjs';

describe('skill command execution', () => {
	it('runs declared skill commands only after approval in a sandbox executor', async () => {
		const cwd = await mkWorkspace({
			'skills/tools/SKILL.md': [
				'---',
				'name: tools',
				'commands:',
				'  - name: summarize',
				'    path: scripts/summarize.mjs',
				'    description: Summarize project data',
				'    args: --json',
				'---',
				'Use helpers.',
			].join('\n'),
			'skills/tools/scripts/summarize.mjs': 'console.log("summary");',
		});
		const runDir = join(cwd, '.kodr/run');
		const calls = [];
		const approvals = [];
		const executor = {
			backend: 'docker',
			run: async (runCwd, parsed, timeoutMs, options) => {
				calls.push({ options, parsed, runCwd, timeoutMs });
				return {
					exitCode: 0,
					execution: { environment: 'docker' },
					stderr: '',
					stdout: 'summary\n',
					timedOut: false,
				};
			},
		};

		const result = await runSkillCommand(
			cwd,
			{ command: 'summarize', skill: 'tools' },
			{
				executor,
				permissionApprover: async (request) => {
					approvals.push(request);
					return { decision: 'allow' };
				},
				runDir,
				timeoutMs: 1234,
			},
		);

		assert.equal(result.ok, true);
		assert.equal(result.stdout, 'summary\n');
		assert.equal(calls[0].parsed.bin, 'node');
		assert.deepEqual(calls[0].parsed.args, ['scripts/summarize.mjs', '--json']);
		assert.deepEqual(calls[0].options, {
			network: 'none',
			readOnlyWorkspace: true,
		});
		assert.equal(approvals[0].capabilities.network, 'none');
		assert.equal(approvals[0].capabilities.workspace, 'read-only');
		assert.match(approvals[0].command, /node scripts\/summarize\.mjs --json/u);
		const artifact = JSON.parse(
			await readFile(
				join(runDir, 'skill-commands/tools-summarize.json'),
				'utf8',
			),
		);
		assert.equal(artifact.sandbox, 'docker');
		assert.equal(artifact.stderr, '');
	});

	it('rejects denial missing sandbox timeout and path traversal', async () => {
		const cwd = await mkWorkspace({
			'outside.mjs': 'console.log("outside")',
			'skills/tools/SKILL.md': [
				'---',
				'name: tools',
				'commands:',
				'  - name: summarize',
				'    path: scripts/summarize.mjs',
				'  - name: escape',
				'    path: ../outside.mjs',
				'  - name: slow',
				'    path: scripts/slow.mjs',
				'---',
				'Use helpers.',
			].join('\n'),
			'skills/tools/scripts/slow.mjs': 'while(true){}',
			'skills/tools/scripts/summarize.mjs': 'console.log("summary");',
		});
		const executor = {
			backend: 'docker',
			run: async () => ({
				exitCode: 1,
				execution: { environment: 'docker' },
				stderr: 'timed out',
				stdout: '',
				timedOut: true,
			}),
		};

		await assert.rejects(
			() => runSkillCommand(cwd, { command: 'summarize', skill: 'tools' }),
			SkillExecutionError,
		);
		await assert.rejects(
			() =>
				runSkillCommand(
					cwd,
					{ command: 'summarize', skill: 'tools' },
					{
						executor,
						permissionApprover: async () => ({
							decision: 'deny',
							reason: 'not approved',
						}),
					},
				),
			/not approved/u,
		);
		await assert.rejects(
			() =>
				runSkillCommand(
					cwd,
					{ command: 'escape', skill: 'tools' },
					{
						executor,
						permissionApprover: async () => ({ decision: 'allow' }),
					},
				),
			/Parent path segments/u,
		);
		const timedOut = await runSkillCommand(
			cwd,
			{ command: 'slow', skill: 'tools' },
			{
				executor,
				permissionApprover: async () => ({ decision: 'allow' }),
			},
		);
		assert.equal(timedOut.ok, false);
		assert.equal(timedOut.timedOut, true);
	});
});

async function mkWorkspace(files) {
	const cwd = await mkdtemp(join(tmpdir(), 'kodr-skill-exec-'));

	for (const [path, content] of Object.entries(files)) {
		const absolute = join(cwd, path);
		await mkdir(join(absolute, '..'), { recursive: true });
		await writeFile(absolute, content, 'utf8');
	}

	return cwd;
}
