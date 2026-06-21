// Human-readable summary for non-JSON `kodr run`. Artifacts still live in the
// run dir, but the terminal should show what actually happened — the model's
// answer or proposal, what it touched, token cost, and test outcome — not just
// "Run ok" and a path.
export function renderRunSummary(result) {
	const lines = [];
	const stop = result.loopBudget?.stopReason || '';
	lines.push(
		`${result.ok ? 'Run ok' : 'Run failed'}${stop ? ` — ${stop}` : ''}`,
	);
	lines.push(`Model: ${result.model}`);

	const usageLine = renderUsageLine(result.usage);
	if (usageLine) {
		lines.push(usageLine);
	}

	if (result.proposalError) {
		lines.push('');
		lines.push(
			`No proposal extracted (${result.proposalError.name}: ${result.proposalError.message})`,
		);
		appendResponseBlock(lines, result.response);
	} else if (result.proposal) {
		const writes = result.writeResult?.writes || [];
		const mode = result.applied
			? 'applied'
			: result.applyDecision === 'prompt-declined'
				? 'dry-run (declined)'
				: result.applyRequested
					? 'not applied'
					: 'dry-run (no changes written)';
		lines.push('');
		lines.push(
			`Proposal: ${result.proposalStatus || 'OK'} — ${writes.length} file(s), ${mode}`,
		);
		for (const write of writes) {
			lines.push(`  ${write.status.padEnd(7)}${write.path}`);
		}
		if (result.treeState && result.treeState !== 'not-a-repo') {
			lines.push(`Tree before apply: ${result.treeState}`);
		}
		if (result.gitCommit?.committed) {
			lines.push(
				`Committed: ${result.gitCommit.sha.slice(0, 10)} (${result.gitCommit.files.length} file(s))`,
			);
		} else if (result.gitCommit?.error) {
			lines.push(`Commit: ${result.gitCommit.error}`);
		}

		if (result.proposal.scratchpad) {
			lines.push('');
			lines.push('Scratchpad:');
			lines.push(indentBlock(result.proposal.scratchpad));
		}

		const messages = result.proposal.messages || [];
		if (messages.length > 0) {
			lines.push('');
			lines.push('Messages:');
			for (const message of messages) {
				lines.push(`  [${message.level}] ${message.content}`);
			}
		}

		if (result.writeError) {
			lines.push('');
			lines.push(
				`Write error (${result.writeError.name}): ${result.writeError.message}`,
			);
		}

		if (result.runError) {
			lines.push('');
			lines.push(
				`Run error (${result.runError.name}): ${result.runError.message}`,
			);
		}

		// A proposal with no files and no messages is effectively a plain answer;
		// show the text so the run isn't a silent no-op.
		if (writes.length === 0 && messages.length === 0) {
			appendResponseBlock(lines, result.response);
		}
	} else if (
		!result.proposalError &&
		!result.proposal &&
		result.responseChars !== undefined &&
		result.responseChars <= 2
	) {
		// E4: near-empty response (whitespace only) with no proposal — surface
		// this clearly so the user and forensics know what happened.
		// responseChars <= 2 covers "\n\n" (2 chars) and "" (0 chars).
		lines.push('');
		lines.push(
			`Proposal: MISSING — response was empty (${result.responseChars} chars)`,
		);
	} else {
		appendResponseBlock(lines, result.response);
	}

	if (result.staged?.runawayRetries > 0) {
		lines.push(
			`  (note: ${result.staged.runawayRetries} staged implement turn(s) hit reasoning ` +
				`runaway and were retried with a capped max_tokens — see summary.json for evidence)`,
		);
	}

	if (result.testResult) {
		lines.push('');
		lines.push(
			`Tests: ${result.testResult.ok ? 'passed' : 'failed'} (${result.testResult.command})`,
		);
	}

	if (result.healingResult) {
		lines.push('');
		const hr = result.healingResult;
		if (hr.stopReason === 'timeout') {
			// D2: surface elapsed and limit so the user knows what happened and
			// how to raise the budget.
			const timedOut = hr.repairs?.find((r) => r.stopReason === 'timeout');
			const elapsed = timedOut?.elapsedMs ?? timedOut?.durationMs;
			const limit = timedOut?.timeoutMs;
			const elapsedSec =
				elapsed != null ? `${Math.round(elapsed / 1000)}s` : '?';
			const limitSec = limit != null ? `${Math.round(limit / 1000)}s` : '?';
			lines.push(
				`Repairs: not healed (timeout) — repair turn timed out after ${elapsedSec} (limit ${limitSec}). Raise with --repair-timeout-ms.`,
			);
		} else if (hr.stopReason === 'reasoning_runaway') {
			// Phase 231: reasoning-token runaway — model exhausted its context window
			// on chain-of-thought and returned zero answer tokens.
			const runaway = hr.repairs?.find(
				(r) => r.stopReason === 'reasoning_runaway',
			);
			const rw = runaway?.runaway || {};
			const reasoningTokens =
				rw.completionTokens != null ? rw.completionTokens : '?';
			const contextSize =
				rw.contextWindow != null
					? rw.contextWindow
					: rw.totalTokens != null
						? rw.totalTokens
						: '?';
			lines.push(
				`Repairs: not healed (reasoning_runaway) — the model exhausted its context window on reasoning without emitting a repair (finish_reason: length, ${reasoningTokens} reasoning tokens / ${contextSize} context). Its thinking budget is not being honored; try a smaller task or a model with an effective thinking cap.`,
			);
		} else if (hr.stopReason === 'repair_context_overflow') {
			// Phase 242: LM Studio KV-cache from the main loop bled into the repair
			// request and the server returned HTTP 400 on both the first attempt and
			// the retry.
			lines.push(
				'Repairs: not healed (repair_context_overflow) — the repair request returned HTTP 400 ' +
					'"Context size exceeded". LM Studio\'s KV-cache from the main loop may have carried ' +
					'over; a retry was attempted. Retry the run or restart LM Studio if this persists.',
			);
		} else {
			lines.push(
				`Repairs: ${hr.healed ? 'healed' : 'not healed'} (${hr.stopReason})`,
			);
		}
		if (hr.healContextOverflowRetries > 0) {
			lines.push(
				`  (note: ${hr.healContextOverflowRetries} repair turn(s) hit HTTP-400 context overflow ` +
					`and were retried — LM Studio KV-cache bleed from main loop)`,
			);
		}
	}

	if (result.installResult) {
		lines.push('');
		lines.push(
			`Install: ${result.installResult.ok ? 'passed' : 'failed'} (${result.installResult.command})`,
		);
	}

	const hasUnappliedWrites =
		!result.applied && (result.writeResult?.writes || []).length > 0;
	lines.push('');
	if (hasUnappliedWrites) {
		if (result.applyDecision === 'prompt-declined') {
			lines.push(
				'Apply declined. Re-run with --yes to apply, or use --confirm to prompt again.',
			);
		} else {
			lines.push('Re-run with --yes to apply these changes.');
		}
	}
	lines.push(`Run dir: ${result.runDir}`);
	lines.push(`Full response: ${result.responsePath}`);

	return `${lines.join('\n')}\n`;
}

// Format a usage object as a single human-readable line.
// e.g. "Tokens: 1,234 (prompt 900 / completion 334)  Cost: $0.0021"
function renderUsageLine(usage) {
	if (!usage) {
		return '';
	}
	const total = usage.tokens.toLocaleString();
	let line = `Tokens: ${total}`;
	const details = [];
	if (usage.promptTokens > 0) {
		details.push(`prompt ${usage.promptTokens.toLocaleString()}`);
	}
	if (usage.completionTokens > 0) {
		details.push(`completion ${usage.completionTokens.toLocaleString()}`);
	}
	if (usage.cachedTokens > 0) {
		details.push(`cached ${usage.cachedTokens.toLocaleString()}`);
	}
	if (
		usage.cacheReadTokens > 0 &&
		usage.cacheReadTokens !== usage.cachedTokens
	) {
		details.push(`cache read ${usage.cacheReadTokens.toLocaleString()}`);
	}
	if (usage.cacheWriteTokens > 0) {
		details.push(`cache write ${usage.cacheWriteTokens.toLocaleString()}`);
	}
	if (details.length > 0) {
		line += ` (${details.join(' / ')})`;
	}
	const cost = usage.cost ?? usage.costUsd ?? 0;
	if (cost > 0) {
		line += `  Cost: $${cost.toFixed(4)}`;
	}
	return line;
}

function appendResponseBlock(lines, response) {
	const text = (response || '').trim();
	if (!text) {
		return;
	}
	lines.push('');
	lines.push('Response:');
	lines.push(indentBlock(text));
}

function indentBlock(text) {
	return text
		.split('\n')
		.map((line) => `  ${line}`)
		.join('\n');
}
