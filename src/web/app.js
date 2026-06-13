/* kodr web UI — vanilla, zero-dep, same-origin fetch/EventSource */
/* jshint esversion: 11 */

(function () {
	'use strict';

	// --- localStorage helpers ---
	const LS_MODEL = 'kodr:model';
	const LS_TEST = 'kodr:test';
	const LS_APPLY = 'kodr:apply';
	const LS_TOOLS = 'kodr:tools';
	const LS_HISTORY = 'kodr:prompt-history';
	const MAX_HISTORY = 10;

	function lsGet(key, fallback) {
		try {
			const v = localStorage.getItem(key);
			return v === null ? fallback : v;
		} catch {
			return fallback;
		}
	}

	function lsSet(key, value) {
		try {
			localStorage.setItem(key, value);
		} catch {
			// ignore
		}
	}

	function lsGetJson(key, fallback) {
		try {
			const v = localStorage.getItem(key);
			return v === null ? fallback : JSON.parse(v);
		} catch {
			return fallback;
		}
	}

	function lsSetJson(key, value) {
		try {
			localStorage.setItem(key, JSON.stringify(value));
		} catch {
			// ignore
		}
	}

	// --- DOM refs ---
	const $ = (id) => document.getElementById(id);

	const navRun = $('nav-run');
	const navRuns = $('nav-runs');
	const navSessions = $('nav-sessions');
	const panelRun = $('panel-run');
	const panelRuns = $('panel-runs');
	const panelSessions = $('panel-sessions');

	const runForm = $('run-form');
	const promptEl = $('prompt');
	const modelEl = $('model');
	const testEl = $('test');
	const applyEl = $('apply');
	const toolsEl = $('tools');
	const submitBtn = $('submit-btn');
	const promptHistoryEl = $('prompt-history');

	const livePanel = $('live-panel');
	const runStatusBar = $('run-status-bar');
	const tokenStream = $('token-stream');
	const eventLog = $('event-log');

	const runsList = $('runs-list');
	const runDetail = $('run-detail');
	const runDetailContent = $('run-detail-content');
	const refreshRunsBtn = $('refresh-runs');

	const sessionsList = $('sessions-list');
	const refreshSessionsBtn = $('refresh-sessions');

	// --- Navigation ---
	function showPanel(name) {
		const panels = { run: panelRun, runs: panelRuns, sessions: panelSessions };
		const btns = { run: navRun, runs: navRuns, sessions: navSessions };
		for (const [k, el] of Object.entries(panels)) {
			el.classList.toggle('active', k === name);
			el.classList.toggle('hidden', k !== name);
		}
		for (const [k, el] of Object.entries(btns)) {
			el.classList.toggle('active', k === name);
		}
		if (name === 'runs') loadRuns();
		if (name === 'sessions') loadSessions();
	}

	navRun.addEventListener('click', () => showPanel('run'));
	navRuns.addEventListener('click', () => showPanel('runs'));
	navSessions.addEventListener('click', () => showPanel('sessions'));

	// --- Restore persisted form state ---
	modelEl.value = lsGet(LS_MODEL, '');
	testEl.value = lsGet(LS_TEST, '');
	applyEl.checked = lsGet(LS_APPLY, 'false') === 'true';
	toolsEl.checked = lsGet(LS_TOOLS, 'false') === 'true';
	restorePromptHistory();

	function restorePromptHistory() {
		const history = lsGetJson(LS_HISTORY, []);
		promptHistoryEl.innerHTML =
			'<option value="">— select to restore —</option>';
		for (const entry of history) {
			const opt = document.createElement('option');
			opt.value = entry;
			opt.textContent = entry.length > 80 ? entry.slice(0, 80) + '…' : entry;
			promptHistoryEl.appendChild(opt);
		}
	}

	promptHistoryEl.addEventListener('change', () => {
		if (promptHistoryEl.value) {
			promptEl.value = promptHistoryEl.value;
			promptHistoryEl.value = '';
		}
	});

	function savePromptToHistory(text) {
		if (!text.trim()) return;
		const history = lsGetJson(LS_HISTORY, []).filter((e) => e !== text);
		history.unshift(text);
		if (history.length > MAX_HISTORY) history.length = MAX_HISTORY;
		lsSetJson(LS_HISTORY, history);
		restorePromptHistory();
	}

	// --- New run form ---
	let activeEventSource = null;

	runForm.addEventListener('submit', async (evt) => {
		evt.preventDefault();
		const prompt = promptEl.value.trim();
		if (!prompt) return;

		// Persist form state
		lsSet(LS_MODEL, modelEl.value.trim());
		lsSet(LS_TEST, testEl.value.trim());
		lsSet(LS_APPLY, String(applyEl.checked));
		lsSet(LS_TOOLS, String(toolsEl.checked));
		savePromptToHistory(prompt);

		const body = { prompt };
		if (modelEl.value.trim()) body.model = modelEl.value.trim();
		if (testEl.value.trim()) body.test = testEl.value.trim();
		if (applyEl.checked) body.yes = true;
		if (toolsEl.checked) body.tools = true;

		submitBtn.disabled = true;
		tokenStream.textContent = '';
		eventLog.innerHTML = '';
		runStatusBar.textContent = 'Submitting…';
		livePanel.classList.remove('hidden');

		if (activeEventSource) {
			activeEventSource.close();
			activeEventSource = null;
		}

		let eventsUrl;
		try {
			const resp = await fetch('/runs', {
				method: 'POST',
				headers: { 'content-type': 'application/json' },
				body: JSON.stringify(body),
			});
			if (!resp.ok) {
				const err = await resp.json().catch(() => ({ error: resp.statusText }));
				throw new Error(err.error || resp.statusText);
			}
			const data = await resp.json();
			eventsUrl = data.eventsUrl;
			runStatusBar.textContent = `Run ${data.runId} — ${data.status}`;
		} catch (err) {
			runStatusBar.textContent = `Error: ${err.message}`;
			submitBtn.disabled = false;
			return;
		}

		openEventSource(eventsUrl, () => {
			submitBtn.disabled = false;
		});
	});

	function openEventSource(eventsUrl, onDone) {
		const es = new EventSource(eventsUrl);
		activeEventSource = es;

		es.addEventListener('token', (e) => {
			const data = safeJson(e.data);
			if (data && data.text) {
				tokenStream.textContent += data.text;
				tokenStream.scrollTop = tokenStream.scrollHeight;
			}
		});

		es.addEventListener('progress', (e) => {
			const data = safeJson(e.data);
			if (!data) return;
			appendEventEntry(data);
		});

		es.addEventListener('log', (e) => {
			const data = safeJson(e.data);
			if (!data) return;
			const div = document.createElement('div');
			div.className = 'event-entry log';
			div.textContent = data.line || '';
			eventLog.appendChild(div);
		});

		es.addEventListener('status', (e) => {
			const data = safeJson(e.data);
			if (data && data.status) {
				runStatusBar.textContent = `Status: ${data.status}${data.cancelRequested ? ' (cancel requested)' : ''}`;
			}
		});

		es.addEventListener('done', (e) => {
			const data = safeJson(e.data);
			const ok = data && data.ok;
			const div = document.createElement('div');
			div.className = ok ? 'event-entry done-ok' : 'event-entry done-fail';
			div.textContent = ok
				? `Done — ${data.runDir || 'ok'}`
				: `Failed: ${data.status || 'error'}`;
			eventLog.appendChild(div);
			runStatusBar.textContent = `Finished: ${data && data.status ? data.status : 'done'}`;
			es.close();
			activeEventSource = null;
			if (onDone) onDone();
		});

		es.onerror = () => {
			runStatusBar.textContent += ' (stream closed)';
			es.close();
			activeEventSource = null;
			if (onDone) onDone();
		};
	}

	function appendEventEntry(data) {
		const div = document.createElement('div');
		const evtName = data.event || '';
		div.className = `event-entry ${evtName}`;
		if (evtName === 'agent_start') {
			div.textContent = `Agent started: ${data.agent || ''} (${data.model || ''})`;
		} else if (evtName === 'agent_finish') {
			div.textContent = `Agent finished: ${data.agent || ''} (${data.responseChars || 0} chars)`;
		} else {
			div.textContent = data.message || evtName;
		}
		eventLog.appendChild(div);
	}

	// --- Runs panel ---
	async function loadRuns() {
		runsList.innerHTML = '<em>Loading…</em>';
		runDetail.classList.add('hidden');
		try {
			const resp = await fetch('/runs');
			const data = await resp.json();
			renderRuns(data.runs || []);
		} catch (err) {
			runsList.innerHTML = `<em>Error: ${esc(err.message)}</em>`;
		}
	}

	function renderRuns(runs) {
		if (runs.length === 0) {
			runsList.innerHTML = '<em>No runs yet.</em>';
			return;
		}
		runsList.innerHTML = '';
		for (const run of [...runs].reverse()) {
			const card = document.createElement('div');
			card.className = 'run-card';
			card.innerHTML = `
				<span class="run-id">${esc(run.runId)}</span>
				<span class="run-prompt">${esc(run.promptPreview || '')}</span>
				${badge(run.status)}
			`;
			card.addEventListener('click', () => showRunDetail(run.runId));
			runsList.appendChild(card);
		}
	}

	async function showRunDetail(runId) {
		runDetail.classList.remove('hidden');
		runDetailContent.innerHTML = '<em>Loading…</em>';

		try {
			const [runResp, artifactsResp] = await Promise.all([
				fetch(`/runs/${encodeURIComponent(runId)}`),
				fetch(`/runs/${encodeURIComponent(runId)}/artifacts`),
			]);
			const run = await runResp.json();
			const artifacts = await artifactsResp.json();

			const actions = document.createElement('div');
			actions.className = 'detail-actions';
			const whyLink = document.createElement('a');
			whyLink.href = `/runs/${encodeURIComponent(runId)}/why`;
			whyLink.target = '_blank';
			whyLink.textContent = 'Open /why';
			whyLink.style.color = 'var(--accent)';
			actions.appendChild(whyLink);

			if (run.status === 'running' || run.status === 'queued') {
				const cancelBtn = document.createElement('button');
				cancelBtn.textContent = 'Cancel';
				cancelBtn.addEventListener('click', async () => {
					await fetch(`/runs/${encodeURIComponent(runId)}/cancel`, {
						method: 'POST',
					});
					showRunDetail(runId);
				});
				actions.appendChild(cancelBtn);
			}

			const pre = document.createElement('pre');
			pre.textContent = JSON.stringify(
				{ ...run, artifacts: artifacts.artifacts },
				null,
				2,
			);

			runDetailContent.innerHTML = '';
			runDetailContent.appendChild(actions);
			runDetailContent.appendChild(pre);
		} catch (err) {
			runDetailContent.innerHTML = `<em>Error: ${esc(err.message)}</em>`;
		}
	}

	refreshRunsBtn.addEventListener('click', loadRuns);

	// --- Sessions panel ---
	async function loadSessions() {
		sessionsList.innerHTML = '<em>Loading…</em>';
		try {
			const resp = await fetch('/sessions');
			const data = await resp.json();
			renderSessions(data.sessions || []);
		} catch (err) {
			sessionsList.innerHTML = `<em>Error: ${esc(err.message)}</em>`;
		}
	}

	function renderSessions(sessions) {
		if (sessions.length === 0) {
			sessionsList.innerHTML = '<em>No sessions yet.</em>';
			return;
		}
		sessionsList.innerHTML = '';
		for (const s of sessions) {
			const card = document.createElement('div');
			card.className = 'session-card';
			const continueBtn = document.createElement('button');
			continueBtn.textContent = 'Continue';
			continueBtn.addEventListener('click', () => continueSession(s.sessionId));
			card.innerHTML = `
				<span class="session-id">${esc(s.sessionId)}</span>
				<span class="session-meta">${esc(s.model || '')} · ${s.turnCount || 0} turns · ${esc(s.lastTimestamp || '')}</span>
			`;
			card.appendChild(continueBtn);
			sessionsList.appendChild(card);
		}
	}

	async function continueSession(sessionId) {
		const prompt = window.prompt('Continue prompt:');
		if (!prompt || !prompt.trim()) return;

		showPanel('run');
		tokenStream.textContent = '';
		eventLog.innerHTML = '';
		runStatusBar.textContent = 'Submitting session turn…';
		livePanel.classList.remove('hidden');
		submitBtn.disabled = true;

		try {
			const resp = await fetch(
				`/sessions/${encodeURIComponent(sessionId)}/turns`,
				{
					method: 'POST',
					headers: { 'content-type': 'application/json' },
					body: JSON.stringify({ prompt: prompt.trim() }),
				},
			);
			const data = await resp.json();
			if (!resp.ok) throw new Error(data.error || resp.statusText);
			openEventSource(data.eventsUrl, () => {
				submitBtn.disabled = false;
			});
		} catch (err) {
			runStatusBar.textContent = `Error: ${esc(err.message)}`;
			submitBtn.disabled = false;
		}
	}

	refreshSessionsBtn.addEventListener('click', loadSessions);

	// --- Utilities ---
	function safeJson(str) {
		try {
			return JSON.parse(str);
		} catch {
			return null;
		}
	}

	function esc(str) {
		return String(str)
			.replace(/&/g, '&amp;')
			.replace(/</g, '&lt;')
			.replace(/>/g, '&gt;')
			.replace(/"/g, '&quot;');
	}

	function badge(status) {
		const cls =
			{
				running: 'badge-running',
				completed: 'badge-completed',
				failed: 'badge-failed',
				queued: 'badge-queued',
				cancelled: 'badge-cancelled',
			}[status] || 'badge-queued';
		return `<span class="badge ${cls}">${esc(status || 'unknown')}</span>`;
	}

	// Initial state: show run panel
	showPanel('run');
})();
