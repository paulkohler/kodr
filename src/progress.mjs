export function emitProgress(options, event) {
	if (typeof options?.onProgress === 'function') {
		options.onProgress({
			timestamp: new Date().toISOString(),
			...event,
		});
	}
}

export function formatProgressEvent(event) {
	const agent = event.agent || 'agent';
	const model = event.model ? ` (${event.model})` : '';
	if (event.event === 'agent_start' || event.event === 'subagent_start') {
		return `info: ${agent} started${model}`;
	}
	if (event.event === 'agent_finish' || event.event === 'subagent_finish') {
		const suffix =
			typeof event.responseChars === 'number'
				? `, ${event.responseChars} response chars`
				: '';
		return `info: ${agent} finished${model}${suffix}`;
	}
	return event.message ? `info: ${event.message}` : `info: ${event.event}`;
}

export async function runStartHook(options, event, payload) {
	await options.hooks?.run(event, {
		cwd: options.cwd || '',
		...payload,
	});
}
