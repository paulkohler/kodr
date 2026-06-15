// commands/skills.mjs — list discovered skills and agents (with tier shadows).
// Extracted from app.mjs main() in phase 148 (app split). Verbatim body, exact
// (options, io) → result contract.

import { discoverAgents } from '../agents.mjs';
import { resolvedAgentsDirs, resolvedSkillsDirs } from '../cli/options.mjs';
import { renderSkillsListing } from '../render.mjs';
import { discoverSkillsTiered } from '../skills.mjs';

export async function runSkills(options, io) {
	const { skills, shadows } = await discoverSkillsTiered(io.cwd, {
		skillsDirs: resolvedSkillsDirs(options, io.cwd),
	});
	const { agents, shadows: agentShadows } = await discoverAgents(io.cwd, {
		agentsDirs: resolvedAgentsDirs(options, io.cwd),
	});
	if (options.json) {
		io.stdout.write(
			`${JSON.stringify(
				{
					skills: skills.map((s) => ({
						name: s.name,
						description: s.description,
						path: s.path,
						tier: s.tier,
						absoluteRoot: s.absoluteRoot,
					})),
					agents: agents.map((a) => ({
						name: a.name,
						description: a.description,
						sourcePath: a.sourcePath,
						tier: a.tier,
						modelSpec: a.modelSpec,
						modelAlias: a.modelAlias,
					})),
					shadows,
					agentShadows,
				},
				null,
				2,
			)}\n`,
		);
	} else {
		io.stdout.write(
			renderSkillsListing({ skills, shadows, agents, agentShadows }),
		);
	}
	return {
		ok: true,
		command: 'skills',
		skills,
		agents,
		shadows,
		agentShadows,
	};
}
