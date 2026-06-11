/**
 * Pure-function harness manifest builder and diagnostic renderer.
 * Zero imports — no node: builtins, no internal modules.
 */

/**
 * Build a structured manifest describing which guides and sensors were active
 * in a Kodr run.
 *
 * @param {object} state
 * @returns {{ guides: object[], sensors: object[], coverage: object }}
 */
export function buildHarnessManifest(state = {}) {
	const {
		context,
		contextPacking,
		inspectionIndex,
		inspectionPlan,
		sessionCompaction,
		proposalFound,
		proposalError,
		writeResult,
		writeError,
		postWriteDiagnostics,
		installResult,
		testResult,
		healingResult,
	} = state;

	const guides = [];
	const sensors = [];

	// --- Guides ---

	if (contextPacking?.strategy === 'inspection-aware') {
		guides.push({
			name: 'repomap',
			type: 'computational',
			strategy: contextPacking.strategy,
			symbolCount: inspectionIndex?.totalSymbols ?? 0,
		});
	}

	if (contextPacking?.strategy === 'file-map') {
		guides.push({ name: 'file-map', type: 'computational' });
	}

	if (Array.isArray(contextPacking?.lspInspectors)) {
		for (const name of contextPacking.lspInspectors) {
			guides.push({ name: `lsp-${name}`, type: 'computational' });
		}
	}

	if (context?.agents != null) {
		guides.push({
			name: 'agents-md',
			type: 'inferential',
			chars: context.agents.includedBytes,
		});
	}

	if (context?.memory?.project != null) {
		guides.push({
			name: 'memory-project',
			type: 'inferential',
			chars: context.memory.project.includedBytes,
		});
	}

	if (context?.memory?.user != null) {
		guides.push({
			name: 'memory-user',
			type: 'inferential',
			chars: context.memory.user.includedBytes,
		});
	}

	if (context?.skills?.loaded?.length > 0) {
		guides.push({
			name: 'skills',
			type: 'inferential',
			count: context.skills.loaded.length,
		});
	}

	if (inspectionPlan != null) {
		guides.push({
			name: 'inspection-plan',
			type: 'computational',
			targetFiles: inspectionPlan.inspection.targetFiles.length,
			targetSymbols: inspectionPlan.inspection.targetSymbols.length,
		});
	}

	if (sessionCompaction) {
		guides.push({ name: 'session-compaction', type: 'inferential' });
	}

	// --- Sensors ---

	// json-extraction is always present
	sensors.push({
		name: 'json-extraction',
		type: 'computational',
		ok: proposalFound === true && !proposalError,
	});

	if (writeResult != null || writeError != null) {
		const writes = writeResult?.writes ?? [];
		if (writes.length > 0 || writeError != null) {
			sensors.push({
				name: 'safe-writes',
				type: 'computational',
				ok: writeError == null && (writeResult?.applied ?? false),
				writeCount: writes.length,
				applied: writeResult?.applied ?? false,
			});
		}
	}

	if (postWriteDiagnostics) {
		sensors.push({
			name: 'post-write-diagnostics',
			type: 'computational',
			errors: postWriteDiagnostics.errorCount,
			warnings: postWriteDiagnostics.warningCount,
			inspectors: postWriteDiagnostics.inspectors,
		});
	}

	if (installResult) {
		sensors.push({
			name: 'dependency-install',
			type: 'computational',
			ok: installResult.ok,
		});
	}

	if (testResult) {
		sensors.push({
			name: 'verification',
			type: 'computational',
			command: testResult.command,
			ok: testResult.ok,
		});
	}

	if (healingResult) {
		sensors.push({
			name: 'healing-loop',
			type: 'both',
			turns: healingResult.repairs.length,
			healed: healingResult.healed,
			stopReason: healingResult.stopReason,
		});
	}

	// --- Coverage ---

	const computationalGuides = guides.filter(
		(g) => g.type === 'computational',
	).length;
	const inferentialGuides = guides.filter(
		(g) => g.type === 'inferential',
	).length;
	const computationalSensors = sensors.filter(
		(s) => s.type === 'computational' || s.type === 'both',
	).length;
	const inferentialSensors = sensors.filter(
		(s) => s.type === 'inferential' || s.type === 'both',
	).length;

	const coverage = {
		computationalGuides,
		inferentialGuides,
		computationalSensors,
		inferentialSensors,
		totalControls: guides.length + sensors.length,
	};

	return { guides, sensors, coverage };
}

/**
 * Render a post-write diagnostics report as a string suitable for model input.
 *
 * @param {object|null|undefined} report
 * @param {{ maxLines?: number }} options
 * @returns {string}
 */
export function renderDiagnosticsForModel(report, options = {}) {
	if (report == null) return '';

	const { errorCount = 0, warningCount = 0, files = [] } = report;

	if (errorCount + warningCount === 0) return '';

	const maxLines = options.maxLines ?? 30;
	const showErrors = errorCount > 0;
	const severity = showErrors ? 'error' : 'warning';
	const count = showErrors ? errorCount : warningCount;

	// Collect diagnostic lines, filtering by severity when errors are present
	const lines = [];
	const filesWithDiagnostics = new Set();

	for (const file of files) {
		for (const diag of file.diagnostics ?? []) {
			if (showErrors && diag.severity !== 'error') continue;
			lines.push({ path: file.path, line: diag.line, message: diag.message });
			filesWithDiagnostics.add(file.path);
		}
	}

	const fileCount = filesWithDiagnostics.size;
	const noun = count === 1 ? `1 ${severity}` : `${count} ${severity}(s)`;
	const fileNoun = fileCount === 1 ? '1 file' : `${fileCount} file(s)`;
	const header = `${noun} in ${fileNoun} after your changes:`;

	const shownLines = lines.slice(0, maxLines);
	const remainder = lines.length - shownLines.length;

	const body = shownLines
		.map((d) => `  ${d.path}:${d.line} — ${d.message}`)
		.join('\n');
	const truncationNote = remainder > 0 ? `\n  …and ${remainder} more` : '';

	return `${header}\n\n${body}${truncationNote}\n\nFix these before relying on test results. If a diagnostic is unrelated to your change, say why in scratchpad.`;
}
