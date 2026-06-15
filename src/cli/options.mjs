// cli/options.mjs — shared helpers that derive run inputs from parsed CLI
// options: prompt loading and the context-packer / skills-dir option shaping.
// Extracted from app.mjs in phase 148 (app split). Imported by both the core
// run pipeline (still in app.mjs) and the command modules, so it lives in a
// neutral module rather than app.mjs (which would be circular).

import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { CliError } from '../cli-errors.mjs';
import { jailedPath } from '../safe-writes.mjs';

export function workspaceContextOptions(options, cwd) {
	return {
		completionReserve: options.completionReserve,
		contextWindow: options.contextWindow,
		editFormat: options.editFormat,
		// T4: pass resolved toolWritesMode so context-packer uses channel-aware wording.
		toolWritesMode: options.toolWritesMode || 'auto',
		// C2 (phase 121): the task text is an ESM signal for greenfield workspaces
		// (a prompt naming a .mjs/.cjs target triggers the Node/ESM contract block
		// even before any file exists on disk).
		taskPrompt: options.prompt || '',
		// C3 (phase 122): resolved skill dirs so a project/user `lang:node` override
		// in a dot-folder tier can shadow the builtin Node/ESM guidance.
		...(cwd ? { skillsDirs: resolvedSkillsDirs(options, cwd) } : {}),
		// Phase 124: A-arm of the guidance A/B — suppress the Node/ESM block.
		suppressLanguageGuidance: options.suppressLanguageGuidance || false,
		// Phase 143: pass model so context-packer can detect the model family and
		// inject model-specific guidance (model:devstral etc.).
		model: options.model || '',
		// Phase 145: A-arm of the model-guidance A/B — suppress model-family block.
		suppressModelGuidance: options.suppressModelGuidance || false,
		...(options.contextBudgetChars
			? { totalBytes: options.contextBudgetChars }
			: {}),
	};
}

// K3: resolve skills-dir overrides, converting relative paths to absolute.
export function resolvedSkillsDirs(options, cwd) {
	return (options.skillsDirs || []).map((dir) =>
		dir.startsWith('/') ? dir : join(cwd, dir),
	);
}

// K3: resolve agents-dir overrides, converting relative paths to absolute.
export function resolvedAgentsDirs(options, cwd) {
	return (options.agentsDirs || []).map((dir) =>
		dir.startsWith('/') ? dir : join(cwd, dir),
	);
}

export async function loadPrompt(options, cwd) {
	if (options.prompt && options.promptFile) {
		throw new CliError('Use either -p/--prompt or --prompt-file, not both');
	}

	if (options.prompt) {
		return options.prompt;
	}

	if (options.promptFile) {
		const promptPath = await jailedPath(cwd, options.promptFile);
		return readFile(promptPath.absolute, 'utf8');
	}

	throw new CliError('kodr run requires -p/--prompt or --prompt-file');
}

export async function loadOptionalPrompt(options, cwd) {
	if (!options.prompt && !options.promptFile) {
		return '';
	}
	return loadPrompt(options, cwd);
}
