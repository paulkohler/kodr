// agents.mjs — Claude Code-compatible agent file discovery and parsing.
//
// Agent files use YAML frontmatter: name, description, model (optional), and
// any unknown keys preserved in `frontmatter`. The body is the agent's system
// prompt (persona layer).
//
// Discovery tiers (highest precedence first, same shape as K1 skill tiers):
//   override   — dirs from --agents-dir / config.agentsDirs
//   project    — .kodr/agents/, .claude/agents/ in the workspace
//   user       — ~/.kodr/agents/, ~/.claude/agents/
//
// First hit per agent name wins. Shadowed duplicates are recorded with both
// paths.
//
// Home-dir resolution is injectable via options.homeDir so tests never touch
// the real home directory.

import { readFile, readdir } from 'node:fs/promises';
import { homedir } from 'node:os';
import { basename, join } from 'node:path';
import { parseSlashModelSpec } from './model-specs.mjs';

export class AgentError extends Error {
	constructor(message) {
		super(message);
		this.name = 'AgentError';
	}
}

// Tier labels exposed to the CLI.
export const AGENT_TIERS = [
	{ label: 'override', dirs: null }, // filled at runtime
	{ label: 'project', relative: ['.kodr/agents', '.claude/agents'] },
	{ label: 'user', relative: ['.kodr/agents', '.claude/agents'] },
];

// Discover all agent files across all tiers. Returns:
//   { agents: AgentSpec[], shadows: ShadowRecord[] }
//
// AgentSpec:
//   { name, description, model, frontmatter, body, sourcePath, tier, rawModelSpec }
//
// ShadowRecord:
//   { name, winnerPath, shadowPath, winnerTier, shadowTier }
export async function discoverAgents(cwd, options = {}) {
	const homeBase = options.homeDir || homedir();
	const overrideDirs = options.agentsDirs || [];

	const tierDirs = [
		...overrideDirs.map((dir) => ({ label: 'override', absDir: dir })),
		...['.kodr/agents', '.claude/agents'].map((rel) => ({
			label: 'project',
			absDir: join(cwd, rel),
		})),
		...['.kodr/agents', '.claude/agents'].map((rel) => ({
			label: 'user',
			absDir: join(homeBase, rel),
		})),
	];

	const seen = new Map(); // name -> AgentSpec
	const shadows = [];

	for (const { label, absDir } of tierDirs) {
		let entries;
		try {
			entries = await readdir(absDir);
		} catch {
			// Missing directory — skip silently.
			continue;
		}

		const mdFiles = entries
			.filter((f) => f.endsWith('.md'))
			.sort((a, b) => a.localeCompare(b));

		for (const file of mdFiles) {
			const filePath = join(absDir, file);
			let raw;
			try {
				raw = await readFile(filePath, 'utf8');
			} catch (error) {
				process.stderr.write(
					`warning: could not read agent file ${filePath}: ${error.message}\n`,
				);
				continue;
			}

			const spec = parseAgentMarkdown(raw, filePath, label);

			if (seen.has(spec.name)) {
				shadows.push({
					name: spec.name,
					shadowPath: filePath,
					shadowTier: label,
					winnerPath: seen.get(spec.name).sourcePath,
					winnerTier: seen.get(spec.name).tier,
				});
			} else {
				seen.set(spec.name, spec);
			}
		}
	}

	return { agents: [...seen.values()], shadows };
}

// Parse a Claude Code agent file. Returns an AgentSpec.
export function parseAgentMarkdown(raw, sourcePath, tier = 'project') {
	const parsed = parseAgentFrontmatter(raw);
	const fallbackName = basename(sourcePath, '.md');
	const rawModelSpec = parsed.frontmatter.model || '';
	const { modelSpec, modelAlias } = resolveModelSpec(rawModelSpec);

	return {
		body: parsed.body,
		description: parsed.frontmatter.description || '',
		frontmatter: parsed.frontmatter,
		modelAlias,
		modelSpec,
		name: parsed.frontmatter.name || fallbackName,
		rawModelSpec,
		sourcePath,
		tier,
	};
}

// Attempt to resolve the agent model frontmatter value.
// If it looks like a valid kodr model spec (provider/model or bare model id),
// return it as modelSpec. Aliases like "sonnet", "opus" that don't map to a
// kodr provider are kept as modelAlias and ignored with a warning at use time.
function resolveModelSpec(value) {
	if (!value) {
		return { modelAlias: '', modelSpec: '' };
	}
	try {
		const parsed = parseSlashModelSpec(value);
		// Only treat as a usable spec when it has a real model id.
		if (parsed.model) {
			return { modelAlias: '', modelSpec: value };
		}
	} catch {
		// Not a valid spec.
	}
	// Fallback: treat as an alias (ignored with a note at run time).
	return { modelAlias: value, modelSpec: '' };
}

// Find a single agent by name from a discovered set.
// Throws AgentError with the roster if not found.
export function findAgent(agents, name) {
	const found = agents.find((a) => a.name === name);
	if (!found) {
		const names = agents.map((a) => a.name).join(', ') || '(none)';
		throw new AgentError(
			`Unknown agent: "${name}". Available agents: ${names}`,
		);
	}
	return found;
}

// Returns true when the agent name is one of the orchestration roles that
// phase 93's role-skill system supports. These agents override the builtin
// role skill for subagent-stages runs.
const ORCHESTRATION_ROLES = new Set([
	'planner',
	'implementer',
	'file-author',
	'reviewer',
]);
export function isOrchestrationRole(name) {
	return ORCHESTRATION_ROLES.has(name);
}

// Parse YAML frontmatter from an agent file.
// Format: --- \n key: value \n --- \n body
function parseAgentFrontmatter(raw) {
	if (!raw.startsWith('---\n')) {
		return { body: raw, frontmatter: {} };
	}

	const end = raw.indexOf('\n---', 4);
	if (end === -1) {
		return { body: raw, frontmatter: {} };
	}

	const yamlText = raw.slice(4, end);
	const body = raw.slice(end + 4).replace(/^\n+/u, '');
	const frontmatter = parseSimpleYaml(yamlText);

	return { body, frontmatter };
}

// Minimal YAML parser for agent frontmatter.
// Handles: scalar string values, multi-line values via > and |, unknown keys
// preserved in the returned object. Does not handle nested maps or lists.
function parseSimpleYaml(text) {
	const data = {};
	const lines = text.split('\n');
	let index = 0;

	while (index < lines.length) {
		const line = lines[index];
		const trimmed = line.trim();
		index += 1;

		if (!trimmed || trimmed.startsWith('#')) {
			continue;
		}

		// Only parse top-level keys (no indentation).
		if (/^\s/u.test(line)) {
			continue;
		}

		const sep = trimmed.indexOf(':');
		if (sep === -1) {
			continue;
		}

		const key = trimmed.slice(0, sep).trim();
		const rest = trimmed.slice(sep + 1).trim();

		if (rest === '>' || rest === '|') {
			// Block scalar — collect indented continuation lines.
			const blockLines = [];
			while (index < lines.length && /^\s/u.test(lines[index])) {
				blockLines.push(lines[index].trim());
				index += 1;
			}
			data[key] = blockLines.join(rest === '>' ? ' ' : '\n');
		} else {
			data[key] = unquote(rest);
		}
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
