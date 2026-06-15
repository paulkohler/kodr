// render.mjs — pure CLI text renderers (session views, skills listing).
// Extracted from app.mjs in phase 148 (app split). No I/O, no external deps.

export function renderSessionList(list) {
	if (list.length === 0) {
		return 'No sessions found.\n';
	}
	return `${list
		.map((session) => {
			const status =
				session.ok === null || session.ok === undefined
					? '?'
					: session.ok
						? 'ok'
						: 'fail';
			return `${session.sessionId}  turns=${session.turnCount}  [${status}]  ${session.model}`;
		})
		.join('\n')}\n`;
}

export function renderSessionConversation(conversation) {
	const lines = [`Session: ${conversation.sessionId}`];
	for (const [index, turn] of conversation.turns.entries()) {
		const status =
			turn.ok === null || turn.ok === undefined ? '?' : turn.ok ? 'ok' : 'fail';
		const tokenPart = turn.tokens > 0 ? `  tokens=${turn.tokens}` : '';
		lines.push('');
		lines.push(`Turn ${index + 1}  [${status}]  ${turn.model}${tokenPart}`);
		lines.push(
			`  User: ${turn.user.slice(0, 120)}${turn.user.length > 120 ? '…' : ''}`,
		);
		lines.push(
			`  Assistant: ${turn.assistant.slice(0, 120)}${turn.assistant.length > 120 ? '…' : ''}`,
		);
	}
	return `${lines.join('\n')}\n`;
}

export function renderSessionMarkdown(conversation) {
	const lines = [
		`# Kodr Session ${conversation.sessionId}`,
		'',
		`- Session ID: \`${conversation.sessionId}\``,
		`- Turns: ${conversation.turns.length}`,
		'',
	];

	for (const [index, turn] of conversation.turns.entries()) {
		const status =
			turn.ok === null || turn.ok === undefined ? '?' : turn.ok ? 'ok' : 'fail';
		lines.push(`## Turn ${index + 1}`);
		lines.push('');
		lines.push(`- Model: \`${turn.model}\``);
		lines.push(`- Status: ${status}`);
		if (turn.tokens > 0) {
			lines.push(`- Tokens: ${turn.tokens}`);
		}
		lines.push(`- Run: \`${turn.runDir}\``);
		lines.push('');
		lines.push('### User');
		lines.push('');
		lines.push(fencedMarkdown(turn.user));
		lines.push('');
		lines.push('### Assistant');
		lines.push('');
		lines.push(fencedMarkdown(turn.assistant));
		lines.push('');
	}

	return `${lines.join('\n')}`;
}

function fencedMarkdown(text) {
	const fence = text.includes('```') ? '````' : '```';
	return `${fence}\n${text}\n${fence}`;
}

export function renderSkillsListing({ skills, shadows, agents, agentShadows }) {
	const lines = [];

	if (skills.length > 0) {
		lines.push('Skills:');
		for (const skill of skills) {
			const desc = skill.description
				? ` — ${skill.description.slice(0, 60)}${skill.description.length > 60 ? '…' : ''}`
				: '';
			const metaOnly = skill.bodyOmitted
				? ' (metadata only — over byte budget)'
				: '';
			lines.push(`  [${skill.tier}] ${skill.name}${desc}${metaOnly}`);
			lines.push(`         ${skill.path}`);
		}
	} else {
		lines.push('Skills: (none)');
	}

	if (shadows.length > 0) {
		lines.push('');
		lines.push('Shadowed skills (lower-tier duplicates):');
		for (const s of shadows) {
			lines.push(`  ${s.name}: ${s.winnerTier} wins over ${s.shadowTier}`);
			lines.push(`    winner:  ${s.winnerPath}`);
			lines.push(`    shadow:  ${s.shadowPath}`);
		}
	}

	if (agents.length > 0) {
		lines.push('');
		lines.push('Agents:');
		for (const agent of agents) {
			const desc = agent.description
				? ` — ${agent.description.slice(0, 60)}${agent.description.length > 60 ? '…' : ''}`
				: '';
			const modelNote = agent.modelSpec
				? ` (model: ${agent.modelSpec})`
				: agent.modelAlias
					? ` (alias: ${agent.modelAlias})`
					: '';
			lines.push(`  [${agent.tier}] ${agent.name}${modelNote}${desc}`);
			lines.push(`         ${agent.sourcePath}`);
		}
	} else {
		lines.push('');
		lines.push('Agents: (none)');
	}

	if (agentShadows?.length > 0) {
		lines.push('');
		lines.push('Shadowed agents (lower-tier duplicates):');
		for (const s of agentShadows) {
			lines.push(`  ${s.name}: ${s.winnerTier} wins over ${s.shadowTier}`);
			lines.push(`    winner:  ${s.winnerPath}`);
			lines.push(`    shadow:  ${s.shadowPath}`);
		}
	}

	return `${lines.join('\n')}\n`;
}
