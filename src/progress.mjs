export function emitProgress(options, event) {
	if (typeof options?.onProgress === 'function') {
		options.onProgress({
			timestamp: new Date().toISOString(),
			...event,
		});
	}
}

export async function runStartHook(options, event, payload) {
	await options.hooks?.run(event, {
		cwd: options.cwd || '',
		...payload,
	});
}
