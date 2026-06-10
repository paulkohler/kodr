import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
	createRunRegistry,
	isFinalStatus,
	phaseForProgressEvent,
	publicRun,
} from '../src/run-registry.mjs';

describe('createRunRegistry', () => {
	it('submits runs as queued with a queue reason when slots are full', () => {
		const registry = createRunRegistry({ maxActiveRuns: 1 });
		const first = registry.submit({ model: 'm', prompt: 'one' });
		registry.markRunning(first.runId);
		const second = registry.submit({ model: 'm', prompt: 'two' });

		assert.equal(first.status, 'running');
		assert.equal(second.status, 'queued');
		assert.match(second.queueReason, /active run slot/u);
		assert.equal(registry.canStart(), false);
		assert.equal(registry.queuedRuns().length, 1);
	});

	it('tracks lifecycle transitions with timestamps and done events', () => {
		const registry = createRunRegistry();
		const run = registry.submit({ model: 'm', prompt: 'task' });
		assert.equal(run.status, 'queued');
		assert.ok(run.submittedAt);

		registry.markRunning(run.runId);
		assert.equal(run.status, 'running');
		assert.ok(run.startedAt);

		registry.markFinished(run.runId, {
			cost: 0,
			exitReason: 'done',
			ok: true,
			runDir: '.kodr/runs/x',
			sessionId: 'x',
			status: 'completed',
			usage: { totalTokens: 10 },
		});
		assert.equal(run.status, 'completed');
		assert.equal(run.ok, true);
		assert.equal(run.runDir, '.kodr/runs/x');
		assert.equal(run.phase, '');
		assert.ok(run.finishedAt);
		assert.ok(isFinalStatus(run.status));

		const types = registry.eventsSince(run.runId, 0).map((e) => e.type);
		assert.deepEqual(types, ['status', 'status', 'done']);
	});

	it('ignores duplicate finishes after a final status', () => {
		const registry = createRunRegistry();
		const run = registry.submit({ prompt: 'task' });
		registry.markRunning(run.runId);
		registry.markFinished(run.runId, { ok: true, status: 'completed' });
		registry.markFinished(run.runId, { error: 'late', status: 'failed' });

		assert.equal(run.status, 'completed');
		assert.equal(run.error, '');
	});

	it('cancels queued runs outright and only flags running runs', () => {
		const registry = createRunRegistry({ maxActiveRuns: 1 });
		const active = registry.submit({ prompt: 'active' });
		registry.markRunning(active.runId);
		const queued = registry.submit({ prompt: 'queued' });

		registry.requestCancel(queued.runId);
		assert.equal(queued.status, 'cancelled');
		assert.equal(queued.cancelRequested, true);

		registry.requestCancel(active.runId);
		assert.equal(active.status, 'running');
		assert.equal(active.cancelRequested, true);
		assert.ok(active.cancelRequestedAt);
	});

	it('bounds the per-run event buffer but keeps event ids increasing', () => {
		const registry = createRunRegistry({ maxEvents: 5 });
		const run = registry.submit({ prompt: 'task' });
		for (let index = 0; index < 20; index += 1) {
			registry.recordEvent(run.runId, 'progress', { event: `e${index}` });
		}

		const events = registry.eventsSince(run.runId, 0);
		assert.equal(events.length, 5);
		assert.equal(events.at(-1).data.event, 'e19');
		assert.ok(events[0].id < events.at(-1).id);
	});

	it('replays only events after a last-seen id', () => {
		const registry = createRunRegistry();
		const run = registry.submit({ prompt: 'task' });
		registry.recordEvent(run.runId, 'progress', { event: 'a' });
		const marker = registry.recordEvent(run.runId, 'progress', { event: 'b' });
		registry.recordEvent(run.runId, 'progress', { event: 'c' });

		const replay = registry.eventsSince(run.runId, marker.id);
		assert.deepEqual(replay.map((e) => e.data.event).filter(Boolean), ['c']);
	});

	it('notifies subscribers until unsubscribed', () => {
		const registry = createRunRegistry();
		const run = registry.submit({ prompt: 'task' });
		const seen = [];
		const unsubscribe = registry.subscribe(run.runId, (event) =>
			seen.push(event.type),
		);

		registry.recordEvent(run.runId, 'progress', { event: 'a' });
		unsubscribe();
		registry.recordEvent(run.runId, 'progress', { event: 'b' });

		assert.deepEqual(seen, ['progress']);
	});

	it('prunes the oldest finished runs past the cap', () => {
		const registry = createRunRegistry({ maxFinishedRuns: 2 });
		const runs = [];
		for (let index = 0; index < 4; index += 1) {
			const run = registry.submit({ prompt: `task ${index}` });
			registry.markRunning(run.runId);
			registry.markFinished(run.runId, { ok: true, status: 'completed' });
			runs.push(run.runId);
		}

		assert.equal(registry.get(runs[0]), undefined);
		assert.equal(registry.get(runs[1]), undefined);
		assert.ok(registry.get(runs[2]));
		assert.ok(registry.get(runs[3]));
	});

	it('exposes a public snapshot without internal fields', () => {
		const registry = createRunRegistry();
		const run = registry.submit({ model: 'm', prompt: 'task' });
		const snapshot = publicRun(run);

		assert.equal(snapshot.runId, run.runId);
		assert.equal(snapshot.status, 'queued');
		assert.equal('subscribers' in snapshot, false);
		assert.equal('events' in snapshot, false);
		assert.equal('nextEventId' in snapshot, false);
	});
});

describe('phaseForProgressEvent', () => {
	it('maps agent starts to phases and finishes to idle', () => {
		assert.equal(
			phaseForProgressEvent({ agent: 'standard', event: 'agent_start' }),
			'model',
		);
		assert.equal(
			phaseForProgressEvent({ agent: 'planner', event: 'subagent_start' }),
			'planner',
		);
		assert.equal(
			phaseForProgressEvent({ agent: 'planner', event: 'subagent_finish' }),
			'',
		);
		assert.equal(phaseForProgressEvent({ event: 'other' }), null);
		assert.equal(phaseForProgressEvent(null), null);
	});
});
