export class HookError extends Error {
	constructor(message) {
		super(message);
		this.name = 'HookError';
	}
}

export class HookBlockedError extends Error {
	constructor(message, details = {}) {
		super(message);
		this.name = 'HookBlockedError';
		this.details = details;
	}
}

export class HookRegistry {
	constructor(handlers = {}) {
		this.handlers = new Map();

		for (const [event, eventHandlers] of Object.entries(handlers)) {
			for (const handler of eventHandlers) {
				this.add(event, handler);
			}
		}
	}

	add(event, handler) {
		if (!event || typeof event !== 'string') {
			throw new HookError('Hook event must be a non-empty string');
		}

		if (typeof handler !== 'function') {
			throw new HookError(`Hook handler for ${event} must be a function`);
		}

		const handlers = this.handlers.get(event) || [];
		handlers.push(handler);
		this.handlers.set(event, handlers);
		return this;
	}

	async run(event, payload) {
		let nextPayload = payload;
		const decisions = [];

		for (const handler of this.handlers.get(event) || []) {
			const result = (await handler(nextPayload)) || {};
			const decision = normalizeDecision(event, result);
			decisions.push(decision);

			if (decision.action === 'block') {
				throw new HookBlockedError(decision.reason, {
					decisions,
					event,
				});
			}

			if (Object.hasOwn(decision, 'payload')) {
				nextPayload = decision.payload;
			}
		}

		return {
			decisions,
			payload: nextPayload,
		};
	}
}

export function normalizeDecision(event, result) {
	const action = result.action || 'allow';
	if (action !== 'allow' && action !== 'mutate' && action !== 'block') {
		throw new HookError(`Unknown hook action for ${event}: ${action}`);
	}

	if (action === 'block') {
		return {
			action,
			reason: result.reason || `Hook blocked ${event}`,
		};
	}

	if (action === 'mutate') {
		if (!Object.hasOwn(result, 'payload')) {
			throw new HookError(`Mutating hook for ${event} must return payload`);
		}

		return {
			action,
			note: result.note || '',
			payload: result.payload,
		};
	}

	return {
		action,
		note: result.note || '',
	};
}

export function createHooks(handlers = {}) {
	return handlers instanceof HookRegistry
		? handlers
		: new HookRegistry(handlers);
}
