import { mkdir } from 'node:fs/promises';
import { basename, dirname, extname, join } from 'node:path';
import { writeJson } from './artifacts.mjs';
import { jailedPath } from './safe-writes.mjs';
import { discoverSkills, SkillError } from './skills.mjs';

export class SkillExecutionError extends Error {
	constructor(message) {
		super(message);
		this.name = 'SkillExecutionError';
	}
}

export async function runSkillCommand(cwd, request, options = {}) {
	if (!options.executor) {
		throw new SkillExecutionError(
			'Skill code execution requires an active sandbox executor; use --docker-sandbox or --openshell-sandbox.',
		);
	}
	const skill = await findSkill(cwd, request.skill, options);
	const command = skill.commands.find((item) => item.name === request.command);
	if (!command) {
		throw new SkillExecutionError(
			`Skill command not declared: ${skill.name}/${request.command}`,
		);
	}
	// K4: out-of-tree skills use their own absoluteRoot as the command working
	// directory so jailedPath resolves scripts relative to the skill root.
	const skillDir = skill.absoluteRoot || join(cwd, dirname(skill.path));
	const script = await jailedPath(skillDir, command.path);
	const parsed = commandInvocation(command, script.path);
	const approval = createSkillCommandApproval(skill, command, parsed, options);
	const decision = options.permissionApprover
		? await options.permissionApprover(approval)
		: null;
	if (decision?.decision !== 'allow') {
		throw new SkillExecutionError(
			`Skill command denied: ${decision?.reason || approval.reason}`,
		);
	}

	const startedAt = new Date().toISOString();
	const timeoutMs = command.timeoutMs || options.timeoutMs || 60000;
	const result = await options.executor.run(skillDir, parsed, timeoutMs, {
		network: 'none',
		readOnlyWorkspace: true,
	});
	const summary = {
		approval,
		command: `${parsed.bin} ${parsed.args.join(' ')}`.trim(),
		commandName: command.name,
		description: command.description,
		exitCode: result.exitCode,
		finishedAt: new Date().toISOString(),
		ok: result.exitCode === 0 && !result.timedOut,
		sandbox: result.execution?.environment || options.executor.backend || '',
		skill: skill.name,
		skillPath: skill.path,
		startedAt,
		stderr: result.stderr,
		stdout: result.stdout,
		timedOut: result.timedOut,
	};
	await writeSkillCommandArtifact(options.runDir, summary);
	return summary;
}

function createSkillCommandApproval(skill, command, parsed, options) {
	return {
		action: 'execute_skill_command',
		capabilities: {
			network: 'none',
			workspace: 'read-only',
			writeback: 'none',
		},
		command: `${parsed.bin} ${parsed.args.join(' ')}`.trim(),
		description: command.description,
		input: {
			backend: options.executor?.backend || '',
			command: command.name,
			skill: skill.name,
			// K4: show skill origin so the user can see where the command came from.
			skillSourcePath: skill.path,
			skillTier: skill.tier || 'workspace',
		},
		reason: `Execute declared skill command ${skill.name}/${command.name}`,
		sandbox: options.executor?.backend || '',
		status: 'pending',
	};
}

async function findSkill(cwd, request, options = {}) {
	const matches = (
		await discoverSkills(cwd, { skillsDirs: options.skillsDirs || [] })
	).filter((skill) => skill.name === request || skill.path === request);
	if (matches.length === 0) {
		throw new SkillError(`No SKILL.md matched: ${request}`);
	}
	if (matches.length > 1) {
		throw new SkillError(`Multiple SKILL.md files matched: ${request}`);
	}
	return matches[0];
}

function commandInvocation(command, scriptPath) {
	const bin = command.bin || defaultBin(command.path);
	if (!bin) {
		throw new SkillExecutionError(
			`Skill command ${command.name} must declare bin for ${command.path}`,
		);
	}
	return {
		args: [scriptPath, ...command.args],
		bin,
	};
}

function defaultBin(path) {
	const ext = extname(path);
	if (ext === '.mjs' || ext === '.js' || ext === '.cjs') {
		return 'node';
	}
	if (ext === '.py') {
		return 'python3';
	}
	if (ext === '.sh') {
		return 'sh';
	}
	return '';
}

async function writeSkillCommandArtifact(runDir, summary) {
	if (!runDir) {
		return;
	}
	const dir = join(runDir, 'skill-commands');
	await mkdir(dir, { recursive: true });
	const file = `${safeName(summary.skill)}-${safeName(summary.commandName || summary.command)}.json`;
	await writeJson(join(dir, file), summary);
}

function safeName(value) {
	return basename(String(value)).replace(/[^a-zA-Z0-9_.-]+/gu, '-');
}
