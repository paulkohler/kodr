const FINAL_STATUSES = new Set(['completed', 'failed', 'cancelled']);

const DEFAULT_MAX_EVENTS = 200;
const DEFAULT_MAX_FINISHED_RUNS = 100;
const DEFAULT_MAX_PROMPT_PREVIEW = 200;

let runSequence = 0;

export function createRunRegistry({
	maxActiveRuns = 1,
	maxEvents = DEFAULT_MAX_EVENTS,
	maxFinishedRuns = DEFAULT_MAX_FINISHED_RUNS,
} = {}) {
	const runs = new Map();

	function get(runId) {
		return runs.get(runId);
	}

	function list() {
		return [...runs.values()].map(publicRun);
	}

	function activeCount() {
		return [...runs.values()].filter((run) => run.status === 'running').length;
	}

	function queuedRuns() {
		return [...runs.values()].filter((run) => run.status === 'queued');
	}

	function canStart() {
		return activeCount() < maxActiveRuns;
	}

	function submit({ model = '', prompt = '', sessionId = '' }) {
		runSequence += 1;
		const runId = `run-${Date.now()}-${runSequence}`;
		const now = new Date().toISOString();
		const run = {
			cancelRequested: false,
			cancelRequestedAt: '',
			cost: null,
			error: '',
			events: [],
			exitReason: '',
			finishedAt: '',
			lastEvent: '',
			model,
			nextEventId: 1,
			ok: null,
			phase: '',
			promptPreview: prompt.slice(0, DEFAULT_MAX_PROMPT_PREVIEW),
			queueReason: canStart()
				? ''
				: `Waiting for an active run slot (max ${maxActiveRuns})`,
			runDir: '',
			runId,
			sessionId,
			startedAt: '',
			status: 'queued',
			subscribers: new Set(),
			submittedAt: now,
			updatedAt: now,
			usage: null,
		};
		runs.set(runId, run);
		recordEvent(runId, 'status', { status: 'queued' });
		return run;
	}

	function markRunning(runId) {
		const run = requireRun(runId);
		run.status = 'running';
		run.queueReason = '';
		run.startedAt = new Date().toISOString();
		touch(run);
		recordEvent(runId, 'status', { status: 'running' });
	}

	function markFinished(runId, details = {}) {
		const run = requireRun(runId);
		if (FINAL_STATUSES.has(run.status)) {
			return;
		}
		run.status = details.status || (details.error ? 'failed' : 'completed');
		run.ok = details.ok ?? null;
		run.runDir = details.runDir || run.runDir;
		run.sessionId = details.sessionId || run.sessionId;
		run.exitReason = details.exitReason || '';
		run.usage = details.usage ?? run.usage;
		run.cost = details.cost ?? run.cost;
		run.error = details.error || '';
		run.phase = '';
		run.finishedAt = new Date().toISOString();
		touch(run);
		recordEvent(runId, 'done', {
			ok: run.ok,
			runDir: run.runDir,
			status: run.status,
		});
		pruneFinished();
	}

	function requestCancel(runId) {
		const run = requireRun(runId);
		if (FINAL_STATUSES.has(run.status)) {
			return run;
		}
		run.cancelRequested = true;
		run.cancelRequestedAt = new Date().toISOString();
		touch(run);
		if (run.status === 'queued') {
			markFinished(runId, { status: 'cancelled' });
		} else {
			recordEvent(runId, 'status', {
				cancelRequested: true,
				status: run.status,
			});
		}
		return run;
	}

	function setPhase(runId, phase) {
		const run = requireRun(runId);
		run.phase = phase;
		touch(run);
	}

	function recordEvent(runId, type, data) {
		const run = requireRun(runId);
		const event = {
			data,
			id: run.nextEventId,
			timestamp: new Date().toISOString(),
			type,
		};
		run.nextEventId += 1;
		run.events.push(event);
		if (run.events.length > maxEvents) {
			run.events.splice(0, run.events.length - maxEvents);
		}
		run.lastEvent = describeEvent(event);
		touch(run);
		for (const listener of run.subscribers) {
			listener(event);
		}
		return event;
	}

	// broadcastToken sends a token event to current subscribers only —
	// it is NOT persisted to the event log and will NOT be replayed to
	// late/reconnecting subscribers (live-only, per phase-134 design).
	function broadcastToken(runId, text) {
		const run = runs.get(runId);
		if (!run) {
			return;
		}
		const event = {
			data: { text },
			id: null,
			timestamp: new Date().toISOString(),
			type: 'token',
		};
		for (const listener of run.subscribers) {
			listener(event);
		}
	}

	function eventsSince(runId, lastEventId = 0) {
		const run = requireRun(runId);
		return run.events.filter((event) => event.id > lastEventId);
	}

	function subscribe(runId, listener) {
		const run = requireRun(runId);
		run.subscribers.add(listener);
		return () => {
			run.subscribers.delete(listener);
		};
	}

	function requireRun(runId) {
		const run = runs.get(runId);
		if (!run) {
			throw new Error(`Unknown run: ${runId}`);
		}
		return run;
	}

	function touch(run) {
		run.updatedAt = new Date().toISOString();
	}

	function pruneFinished() {
		const finished = [...runs.values()].filter((run) =>
			FINAL_STATUSES.has(run.status),
		);
		while (finished.length > maxFinishedRuns) {
			const oldest = finished.shift();
			runs.delete(oldest.runId);
		}
	}

	return {
		activeCount,
		broadcastToken,
		canStart,
		eventsSince,
		get,
		list,
		markFinished,
		markRunning,
		maxActiveRuns,
		queuedRuns,
		recordEvent,
		requestCancel,
		setPhase,
		submit,
		subscribe,
	};
}

export function isFinalStatus(status) {
	return FINAL_STATUSES.has(status);
}

export function publicRun(run) {
	return {
		cancelRequested: run.cancelRequested,
		cancelRequestedAt: run.cancelRequestedAt,
		cost: run.cost,
		error: run.error,
		exitReason: run.exitReason,
		finishedAt: run.finishedAt,
		lastEvent: run.lastEvent,
		model: run.model,
		ok: run.ok,
		phase: run.phase,
		promptPreview: run.promptPreview,
		queueReason: run.queueReason,
		runDir: run.runDir,
		runId: run.runId,
		sessionId: run.sessionId,
		startedAt: run.startedAt,
		status: run.status,
		submittedAt: run.submittedAt,
		updatedAt: run.updatedAt,
		usage: run.usage,
	};
}

export function phaseForProgressEvent(event) {
	if (!event || typeof event !== 'object') {
		return null;
	}
	// Token events are live-only and carry no phase information.
	if (event.event === 'token') {
		return null;
	}
	if (event.event === 'agent_start' || event.event === 'subagent_start') {
		return typeof event.agent === 'string' && event.agent !== 'standard'
			? event.agent
			: 'model';
	}
	if (event.event === 'agent_finish' || event.event === 'subagent_finish') {
		return '';
	}
	return null;
}

function describeEvent(event) {
	if (event.type === 'progress') {
		return event.data?.message || event.data?.event || 'progress';
	}
	if (event.type === 'status') {
		return event.data?.cancelRequested
			? `${event.data.status} (cancel requested)`
			: event.data?.status || 'status';
	}
	if (event.type === 'done') {
		return `done: ${event.data?.status || ''}`;
	}
	if (event.type === 'log') {
		return event.data?.line || 'log';
	}
	return event.type;
}
