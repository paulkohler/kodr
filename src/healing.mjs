import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { buildWorkspaceContext } from './context-packer.mjs';
import { extractJson } from './json-extractor.mjs';
import { prepareWrites } from './safe-writes.mjs';
import { runVerification } from './verification-runner.mjs';

export async function oneShotHeal(cwd, failedTest, repairText, options = {}) {
	if (failedTest.ok) {
		return {
			healed: false,
			reason: 'Verification already passed.',
		};
	}

	const context = await buildWorkspaceContext(cwd);
	const lastTest = await readLastTest(cwd);
	const repairPrompt = renderRepairPrompt(context.systemPrompt, lastTest);
	const proposal = extractJson(repairText);
	const apply = options.apply === true || options.yes === true;
	const writes = await prepareWrites(cwd, proposal.files, { apply });
	const verification = apply
		? await runVerification(cwd, options.testCommand, {
				timeoutMs: options.timeoutMs || 60000,
			})
		: null;

	return {
		healed: verification ? verification.ok : false,
		repairPrompt,
		verification,
		writes,
	};
}

function renderRepairPrompt(systemPrompt, lastTest) {
	return `${systemPrompt}

The previous verification failed. Use this test output and propose exactly one repair JSON object.

${lastTest}`;
}

async function readLastTest(cwd) {
	try {
		return await readFile(join(cwd, '.koder', 'last-test.md'), 'utf8');
	} catch {
		return 'No last-test.md was available.';
	}
}
