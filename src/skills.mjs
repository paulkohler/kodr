import { open, readdir, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { listContextFiles } from './context-packer.mjs';
import { jailedPath, SafeWriteError } from './safe-writes.mjs';

export const DEFAULT_SKILL_BYTES = 12000;
export const DEFAULT_TOTAL_SKILL_BYTES = 40000;

export class SkillError extends Error {
	constructor(message) {
		super(message);
		this.name = 'SkillError';
	}
}

// Tier precedence (highest first). This array is exported so future
// conventions are a data edit and tests can assert ordering.
//   override  — dirs from --skills-dir / config.skillsDirs
//   workspace — whole-tree SKILL.md discovery (existing behaviour)
//   project   — .kodr/skills/<name>/SKILL.md, .claude/skills/<name>/SKILL.md
//   user      — ~/.kodr/skills/<name>/SKILL.md, ~/.claude/skills/<name>/SKILL.md
export const SKILL_TIERS = ['override', 'workspace', 'project', 'user'];

// Discover all skills across all tiers. Returns:
//   { skills: SkillSpec[], shadows: ShadowRecord[] }
//
// SkillSpec is the usual parseSkillMarkdown shape plus { tier, absoluteRoot }:
//   tier        — 'override' | 'workspace' | 'project' | 'user'
//   absoluteRoot — absolute directory containing SKILL.md (used for jail)
//
// ShadowRecord: { name, winnerPath, shadowPath, winnerTier, shadowTier }
export async function discoverSkillsTiered(cwd, options = {}) {
	const perSkillBytes = options.perSkillBytes || DEFAULT_SKILL_BYTES;
	const totalSkillBytes = options.totalSkillBytes || DEFAULT_TOTAL_SKILL_BYTES;
	const homeBase = options.homeDir || homedir();
	const overrideDirs = options.skillsDirs || [];

	// Build the ordered list of { label, entries: async () => [{absPath, relPath}] }
	const tierSources = [
		// Tier 1: override dirs
		...overrideDirs.map((dir) => ({
			label: 'override',
			scan: () => scanDotFolderSkills(dir),
		})),
		// Tier 2: workspace tree
		{
			label: 'workspace',
			scan: () => scanWorkspaceSkills(cwd),
		},
		// Tier 3: project dot folders
		{
			label: 'project',
			scan: () =>
				scanDotFolderSkills(join(cwd, '.kodr', 'skills')).then((a) =>
					scanDotFolderSkills(join(cwd, '.claude', 'skills')).then((b) => [
						...a,
						...b,
					]),
				),
		},
		// Tier 4: user dot folders
		{
			label: 'user',
			scan: () =>
				scanDotFolderSkills(join(homeBase, '.kodr', 'skills')).then((a) =>
					scanDotFolderSkills(join(homeBase, '.claude', 'skills')).then((b) => [
						...a,
						...b,
					]),
				),
		},
	];

	const seen = new Map(); // name -> SkillSpec
	const shadows = [];

	for (const { label, scan } of tierSources) {
		let entries;
		try {
			entries = await scan();
		} catch {
			continue;
		}

		let usedBytes = [...seen.values()].reduce(
			(sum, s) => sum + s.includedBytes,
			0,
		);

		for (const { absPath, absoluteRoot, relPath } of entries) {
			if (usedBytes >= totalSkillBytes) {
				break;
			}

			const maxBytes = Math.min(perSkillBytes, totalSkillBytes - usedBytes);
			let loaded;
			try {
				loaded = await readSkillPrefix(absPath, maxBytes);
			} catch (error) {
				process.stderr.write(
					`warning: could not read skill ${absPath}: ${error.message}\n`,
				);
				continue;
			}

			// Workspace skills keep the relative path (backward compat); dot-folder
			// skills use the absolute path since no workspace-relative form exists.
			const skillPath = relPath !== undefined ? relPath : absPath;
			const parsed = parseSkillMarkdown(skillPath, loaded.raw);
			parsed.includedBytes = loaded.includedBytes;
			parsed.truncated = loaded.truncated;
			// Re-attribute workspace-tier entries that live under a project dot-folder
			// prefix (.kodr/skills/ or .claude/skills/) so they report tier 'project'
			// rather than 'workspace'. The context-packer path and content are
			// unchanged — only the display label is corrected.
			const effectiveTier =
				label === 'workspace' &&
				relPath !== undefined &&
				(relPath.startsWith('.kodr/skills/') ||
					relPath.startsWith('.claude/skills/'))
					? 'project'
					: label;
			parsed.tier = effectiveTier;
			parsed.absoluteRoot = absoluteRoot;

			if (seen.has(parsed.name)) {
				const winner = seen.get(parsed.name);
				// Suppress self-shadows: workspace-reclassified project entries are
				// re-encountered by the project tier scan. If absPath resolves to the
				// same file as the winner path (via cwd join), skip the shadow record.
				const winnerAbsPath = winner.path.startsWith('/')
					? winner.path
					: join(cwd, winner.path);
				if (absPath !== winnerAbsPath) {
					shadows.push({
						name: parsed.name,
						shadowPath: absPath,
						shadowTier: label,
						winnerPath: winner.path,
						winnerTier: winner.tier,
					});
				}
			} else {
				seen.set(parsed.name, parsed);
				usedBytes += loaded.includedBytes;
			}
		}
	}

	const skills = [...seen.values()].sort((a, b) =>
		a.name.localeCompare(b.name),
	);
	return { shadows, skills };
}

// discoverSkills — multi-tier discovery. When skillsDirs is provided (non-empty),
// it runs all tiers (override + workspace + project + user). When skillsDirs is
// empty AND no dot-folder dirs exist in the test environment, it behaves the same
// as the original workspace-only scan.
//
// For backward compatibility, the sort order is by path (same as before).
// New callers should use discoverSkillsTiered for the full result including shadows.
export async function discoverSkills(cwd, options = {}) {
	const overrideDirs = options.skillsDirs || [];

	if (overrideDirs.length === 0) {
		// Fast path: workspace-only scan — original behaviour.
		// Dot-folder discovery only activates when overrideDirs are present OR
		// when the caller explicitly sets homeDir (test injectable).
		// This keeps existing tests that don't expect user-level skills working.
		const perSkillBytes = options.perSkillBytes || DEFAULT_SKILL_BYTES;
		const totalSkillBytes =
			options.totalSkillBytes || DEFAULT_TOTAL_SKILL_BYTES;
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
			parsed.tier = 'workspace';
			parsed.absoluteRoot = join(cwd, dirname(path));
			usedBytes += loaded.includedBytes;
			skills.push(parsed);
		}

		return skills.sort((left, right) => left.path.localeCompare(right.path));
	}

	// Full tiered scan when override dirs are provided.
	const { skills } = await discoverSkillsTiered(cwd, options);
	return skills.sort((a, b) => a.path.localeCompare(b.path));
}

// Scan a dot-folder skills directory (<dir>/<name>/SKILL.md).
// Returns [{ absPath, absoluteRoot }]. Silently skips missing dirs.
// Symlinked subdirectories are followed via stat() so that skill dirs
// installed by symlink (e.g. Claude Code's own ~/.claude/skills/) are
// discovered correctly.
async function scanDotFolderSkills(baseDir) {
	let entries;
	try {
		entries = await readdir(baseDir, { withFileTypes: true });
	} catch {
		return [];
	}

	const results = [];
	for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
		const skillDir = join(baseDir, entry.name);
		if (entry.isDirectory()) {
			// Real directory — proceed directly.
		} else if (entry.isSymbolicLink()) {
			// Symlink — stat() follows the link; skip if target is not a directory.
			let targetStat;
			try {
				targetStat = await stat(skillDir);
			} catch {
				continue;
			}
			if (!targetStat.isDirectory()) continue;
		} else {
			continue;
		}
		const skillFile = join(skillDir, 'SKILL.md');
		results.push({ absPath: skillFile, absoluteRoot: skillDir });
	}
	return results;
}

// Scan the workspace tree for SKILL.md files (existing behaviour).
async function scanWorkspaceSkills(cwd) {
	const files = await listContextFiles(cwd);
	const skillPaths = files.filter(
		(file) => file.endsWith('/SKILL.md') || file === 'SKILL.md',
	);
	return skillPaths.map((relPath) => ({
		absPath: `${cwd}/${relPath}`,
		absoluteRoot: join(cwd, dirname(relPath)),
		// Keep the relative path as .path for workspace skills.
		relPath,
	}));
}

export function parseSkillMarkdown(path, raw) {
	const parsed = parseFrontmatter(raw);
	// For relative paths (workspace skills): parent dir name is the fallback name.
	// For absolute paths (dot-folder skills): last path segment before /SKILL.md.
	const parentDir = dirname(path);
	const fallbackName = parentDir.split('/').pop() || 'root';
	const commands = normalizeCommands(parsed.frontmatter.commands);
	const resources = normalizeResources(parsed.frontmatter.resources);

	return {
		body: parsed.body,
		commands,
		description: parsed.frontmatter.description || '',
		frontmatter: parsed.frontmatter,
		includedBytes: Buffer.byteLength(raw),
		name: parsed.frontmatter.name || fallbackName,
		path,
		resources,
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

	return `${skills.map(renderSkillIndexEntry).join('\n')}\n`;
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

export async function loadSkillResource(
	cwd,
	skillRequest,
	resourcePath,
	options = {},
) {
	const maxBytes = options.maxBytes || DEFAULT_SKILL_BYTES;
	const skills = await discoverSkills(cwd, options);
	const matches = skills.filter((skill) => {
		return skill.name === skillRequest || skill.path === skillRequest;
	});

	if (matches.length === 0) {
		throw new SkillError(`No SKILL.md matched: ${skillRequest}`);
	}

	if (matches.length > 1) {
		throw new SkillError(`Multiple SKILL.md files matched: ${skillRequest}`);
	}

	const skill = matches[0];
	const resource = skill.resources.find((item) => item.path === resourcePath);
	if (!resource) {
		throw new SkillError(
			`Skill resource not declared: ${skill.name}/${resourcePath}`,
		);
	}

	// K4: out-of-tree skills (user/project/override tiers) jail resources to the
	// skill's own directory, not the workspace. absoluteRoot is set by
	// discoverSkillsTiered for all dot-folder skills; workspace skills use the
	// workspace-relative skill dir as before.
	const skillDir = skill.absoluteRoot || `${cwd}/${dirname(skill.path)}`;
	let jailed;
	try {
		jailed = await jailedPath(skillDir, resource.path);
	} catch (error) {
		if (error instanceof SafeWriteError) {
			throw new SkillError(
				`Skill resource path escapes skill directory: ${resource.path}`,
			);
		}
		throw error;
	}
	let loaded;
	try {
		loaded = await readSkillPrefix(jailed.absolute, maxBytes);
	} catch (error) {
		if (error?.code === 'ENOENT') {
			throw new SkillError(`Skill resource not found: ${resource.path}`);
		}
		throw error;
	}
	return {
		content: loaded.raw,
		description: resource.description,
		includedBytes: loaded.includedBytes,
		load: resource.load,
		path: resource.path,
		skill: skill.name,
		skillPath: skill.path,
		truncated: loaded.truncated,
	};
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
	const lines = text.split('\n');

	for (let index = 0; index < lines.length; index += 1) {
		const line = lines[index];
		const trimmed = line.trim();
		if (!trimmed || trimmed.startsWith('#')) {
			continue;
		}

		if (/^\s/u.test(line)) {
			continue;
		}

		const separator = trimmed.indexOf(':');
		if (separator === -1) {
			continue;
		}

		const key = trimmed.slice(0, separator).trim();
		const value = trimmed.slice(separator + 1).trim();
		if (value === '' && isIndentedListStart(lines[index + 1])) {
			const parsed = parseYamlList(lines, index + 1);
			data[key] = parsed.items;
			index = parsed.nextIndex - 1;
			continue;
		}
		data[key] = unquote(value);
	}

	return data;
}

function parseYamlList(lines, startIndex) {
	const items = [];
	let current = null;
	let index = startIndex;

	for (; index < lines.length; index += 1) {
		const line = lines[index];
		const trimmed = line.trim();
		if (!trimmed || trimmed.startsWith('#')) {
			continue;
		}
		if (!/^\s/u.test(line)) {
			break;
		}

		const itemMatch = line.match(/^\s*-\s*(.*)$/u);
		if (itemMatch) {
			const value = itemMatch[1].trim();
			current = parseYamlListItem(value);
			items.push(current);
			continue;
		}

		const propertyMatch = line.match(/^\s+([A-Za-z0-9_-]+):\s*(.*)$/u);
		if (current && typeof current === 'object' && propertyMatch) {
			current[propertyMatch[1]] = unquote(propertyMatch[2].trim());
		}
	}

	return { items, nextIndex: index };
}

function parseYamlListItem(value) {
	if (!value) {
		return {};
	}
	const separator = value.indexOf(':');
	if (separator > 0) {
		return {
			[value.slice(0, separator).trim()]: unquote(
				value.slice(separator + 1).trim(),
			),
		};
	}
	return unquote(value);
}

function isIndentedListStart(line = '') {
	return /^\s*-\s*/u.test(line);
}

function normalizeResources(resources) {
	if (!Array.isArray(resources)) {
		return [];
	}
	return resources
		.map((resource) => {
			if (typeof resource === 'string') {
				return {
					description: '',
					load: 'manual',
					path: resource,
				};
			}
			if (!resource || typeof resource !== 'object') {
				return null;
			}
			const path = resource.path || resource.file || '';
			if (!path) {
				return null;
			}
			return {
				description: resource.description || '',
				load: resource.load || 'manual',
				path,
			};
		})
		.filter(Boolean);
}

function renderSkillIndexEntry(skill) {
	const description = skill.description ? ` - ${skill.description}` : '';
	const resources =
		skill.resources?.length > 0
			? `\n  resources:\n${skill.resources
					.map((resource) => {
						const resourceDescription = resource.description
							? ` - ${resource.description}`
							: '';
						return `  - ${resource.path} (${resource.load})${resourceDescription}`;
					})
					.join('\n')}`
			: '';
	const commands =
		skill.commands?.length > 0
			? `\n  commands:\n${skill.commands
					.map((command) => {
						const commandDescription = command.description
							? ` - ${command.description}`
							: '';
						return `  - ${command.name} -> ${command.path}${commandDescription}`;
					})
					.join('\n')}`
			: '';
	return `- ${skill.name} (${skill.path})${description}${resources}${commands}`;
}

function normalizeCommands(commands) {
	if (!Array.isArray(commands)) {
		return [];
	}
	return commands
		.map((command) => {
			if (!command || typeof command !== 'object') {
				return null;
			}
			if (!command.name || !command.path) {
				return null;
			}
			return {
				args: splitArgs(command.args || command.fixedArgs || ''),
				bin: command.bin || '',
				description: command.description || '',
				name: command.name,
				path: command.path,
				timeoutMs: Number(command.timeoutMs || 0) || 0,
			};
		})
		.filter(Boolean);
}

function splitArgs(value) {
	if (!value) {
		return [];
	}
	if (Array.isArray(value)) {
		return value.map(String);
	}
	return String(value).trim().split(/\s+/u).filter(Boolean);
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
