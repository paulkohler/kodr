// commands/compare.mjs — run one prompt across several models and report.
// Extracted from app.mjs main() in phase 148 (app split). Verbatim body, exact
// (options, io) → result contract.

import { CliError } from '../cli-errors.mjs';
import { loadPrompt, workspaceContextOptions } from '../cli/options.mjs';
import { runComparison } from '../compare.mjs';
import { buildWorkspaceContext } from '../context-packer.mjs';
import { loadMemory } from '../memory.mjs';
import { loadSkills } from '../skills.mjs';

export async function runCompare(options, io) {
	if (!options.models.length) {
		throw new CliError('kodr compare requires --models');
	}
	const prompt = await loadPrompt(options, io.cwd);
	const memory = await loadMemory(io.cwd);
	const skills = await loadSkills(io.cwd, options.skills);
	const context = await buildWorkspaceContext(io.cwd, {
		memory,
		skills,
		...workspaceContextOptions(options, io.cwd),
	});
	const { compDir, comparison } = await runComparison(
		options,
		io.env,
		prompt,
		context.systemPrompt,
		options.models,
		io.cwd,
		options.out,
	);
	if (options.json) {
		io.stdout.write(`${JSON.stringify(comparison, null, 2)}\n`);
	} else {
		io.stdout.write(`Compare ok\n`);
		io.stdout.write(`Run: ${compDir}\n`);
		for (const model of comparison.models) {
			const status = model.ok ? 'ok' : 'failed';
			io.stdout.write(
				`  ${model.modelSpec}: ${status} (${model.responseChars} chars)\n`,
			);
		}
	}
	return { ok: true, command: 'compare', comparison, compDir };
}
