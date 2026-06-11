import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
	buildHarnessManifest,
	renderDiagnosticsForModel,
} from '../src/harness.mjs';

// ---------------------------------------------------------------------------
// buildHarnessManifest
// ---------------------------------------------------------------------------

describe('buildHarnessManifest', () => {
	it('empty state → empty guides, json-extraction sensor always present, correct coverage', () => {
		const { guides, sensors, coverage } = buildHarnessManifest({});

		assert.deepEqual(guides, []);
		assert.equal(sensors.length, 1);
		assert.equal(sensors[0].name, 'json-extraction');
		assert.equal(sensors[0].type, 'computational');

		assert.equal(coverage.computationalGuides, 0);
		assert.equal(coverage.inferentialGuides, 0);
		assert.equal(coverage.computationalSensors, 1);
		assert.equal(coverage.inferentialSensors, 0);
		assert.equal(coverage.totalControls, 1);
	});

	it('no arguments → same as empty state (default parameter)', () => {
		const { guides, sensors } = buildHarnessManifest();
		assert.deepEqual(guides, []);
		assert.equal(sensors.length, 1);
		assert.equal(sensors[0].name, 'json-extraction');
	});

	// --- Guides ---

	it('inspection-aware contextPacking → repomap guide', () => {
		const state = {
			contextPacking: { strategy: 'inspection-aware' },
			inspectionIndex: { totalSymbols: 42 },
		};
		const { guides } = buildHarnessManifest(state);
		const guide = guides.find((g) => g.name === 'repomap');
		assert.ok(guide, 'repomap guide should be present');
		assert.equal(guide.type, 'computational');
		assert.equal(guide.strategy, 'inspection-aware');
		assert.equal(guide.symbolCount, 42);
	});

	it('inspection-aware contextPacking with no inspectionIndex → symbolCount defaults to 0', () => {
		const state = { contextPacking: { strategy: 'inspection-aware' } };
		const { guides } = buildHarnessManifest(state);
		const guide = guides.find((g) => g.name === 'repomap');
		assert.ok(guide);
		assert.equal(guide.symbolCount, 0);
	});

	it('file-map contextPacking → file-map guide', () => {
		const state = { contextPacking: { strategy: 'file-map' } };
		const { guides } = buildHarnessManifest(state);
		const guide = guides.find((g) => g.name === 'file-map');
		assert.ok(guide, 'file-map guide should be present');
		assert.equal(guide.type, 'computational');
	});

	it('lspInspectors in contextPacking → one lsp-* guide per inspector', () => {
		const state = {
			contextPacking: { lspInspectors: ['typescript', 'eslint'] },
		};
		const { guides } = buildHarnessManifest(state);
		const lspGuides = guides.filter((g) => g.name.startsWith('lsp-'));
		assert.equal(lspGuides.length, 2);
		assert.ok(lspGuides.some((g) => g.name === 'lsp-typescript'));
		assert.ok(lspGuides.some((g) => g.name === 'lsp-eslint'));
		for (const g of lspGuides) {
			assert.equal(g.type, 'computational');
		}
	});

	it('empty lspInspectors array → no lsp guides', () => {
		const state = { contextPacking: { lspInspectors: [] } };
		const { guides } = buildHarnessManifest(state);
		assert.equal(guides.filter((g) => g.name.startsWith('lsp-')).length, 0);
	});

	it('context.agents → agents-md inferential guide with chars', () => {
		const state = { context: { agents: { includedBytes: 1024 } } };
		const { guides } = buildHarnessManifest(state);
		const guide = guides.find((g) => g.name === 'agents-md');
		assert.ok(guide, 'agents-md guide should be present');
		assert.equal(guide.type, 'inferential');
		assert.equal(guide.chars, 1024);
	});

	it('context.agents null → no agents-md guide', () => {
		const state = { context: { agents: null } };
		const { guides } = buildHarnessManifest(state);
		assert.ok(!guides.some((g) => g.name === 'agents-md'));
	});

	it('context.memory.project → memory-project inferential guide with chars', () => {
		const state = {
			context: { memory: { project: { includedBytes: 512 } } },
		};
		const { guides } = buildHarnessManifest(state);
		const guide = guides.find((g) => g.name === 'memory-project');
		assert.ok(guide);
		assert.equal(guide.type, 'inferential');
		assert.equal(guide.chars, 512);
	});

	it('context.memory.user → memory-user inferential guide with chars', () => {
		const state = {
			context: { memory: { user: { includedBytes: 256 } } },
		};
		const { guides } = buildHarnessManifest(state);
		const guide = guides.find((g) => g.name === 'memory-user');
		assert.ok(guide);
		assert.equal(guide.type, 'inferential');
		assert.equal(guide.chars, 256);
	});

	it('context.memory.project null → no memory-project guide', () => {
		const state = { context: { memory: { project: null } } };
		const { guides } = buildHarnessManifest(state);
		assert.ok(!guides.some((g) => g.name === 'memory-project'));
	});

	it('context.skills.loaded with entries → skills inferential guide with count', () => {
		const state = {
			context: { skills: { loaded: ['skill-a', 'skill-b', 'skill-c'] } },
		};
		const { guides } = buildHarnessManifest(state);
		const guide = guides.find((g) => g.name === 'skills');
		assert.ok(guide);
		assert.equal(guide.type, 'inferential');
		assert.equal(guide.count, 3);
	});

	it('context.skills.loaded empty array → no skills guide', () => {
		const state = { context: { skills: { loaded: [] } } };
		const { guides } = buildHarnessManifest(state);
		assert.ok(!guides.some((g) => g.name === 'skills'));
	});

	it('inspectionPlan → inspection-plan computational guide with targetFiles/targetSymbols counts', () => {
		const state = {
			inspectionPlan: {
				inspection: {
					targetFiles: ['a.ts', 'b.ts'],
					targetSymbols: ['Foo', 'Bar', 'Baz'],
				},
			},
		};
		const { guides } = buildHarnessManifest(state);
		const guide = guides.find((g) => g.name === 'inspection-plan');
		assert.ok(guide);
		assert.equal(guide.type, 'computational');
		assert.equal(guide.targetFiles, 2);
		assert.equal(guide.targetSymbols, 3);
	});

	it('sessionCompaction truthy → session-compaction inferential guide', () => {
		const state = { sessionCompaction: true };
		const { guides } = buildHarnessManifest(state);
		const guide = guides.find((g) => g.name === 'session-compaction');
		assert.ok(guide);
		assert.equal(guide.type, 'inferential');
	});

	it('sessionCompaction falsy → no session-compaction guide', () => {
		const state = { sessionCompaction: false };
		const { guides } = buildHarnessManifest(state);
		assert.ok(!guides.some((g) => g.name === 'session-compaction'));
	});

	// --- Sensors ---

	it('writeResult with writes → safe-writes sensor', () => {
		const state = {
			writeResult: { writes: ['file1.ts'], applied: true },
		};
		const { sensors } = buildHarnessManifest(state);
		const sensor = sensors.find((s) => s.name === 'safe-writes');
		assert.ok(sensor);
		assert.equal(sensor.type, 'computational');
		assert.equal(sensor.ok, true);
		assert.equal(sensor.writeCount, 1);
		assert.equal(sensor.applied, true);
	});

	it('writeError → safe-writes sensor with ok=false', () => {
		const state = { writeError: new Error('disk full') };
		const { sensors } = buildHarnessManifest(state);
		const sensor = sensors.find((s) => s.name === 'safe-writes');
		assert.ok(sensor);
		assert.equal(sensor.ok, false);
	});

	it('writeResult with empty writes array and no writeError → no safe-writes sensor', () => {
		const state = { writeResult: { writes: [], applied: false } };
		const { sensors } = buildHarnessManifest(state);
		assert.ok(!sensors.some((s) => s.name === 'safe-writes'));
	});

	it('postWriteDiagnostics → post-write-diagnostics sensor', () => {
		const state = {
			postWriteDiagnostics: {
				errorCount: 2,
				warningCount: 1,
				inspectors: ['typescript'],
			},
		};
		const { sensors } = buildHarnessManifest(state);
		const sensor = sensors.find((s) => s.name === 'post-write-diagnostics');
		assert.ok(sensor);
		assert.equal(sensor.type, 'computational');
		assert.equal(sensor.errors, 2);
		assert.equal(sensor.warnings, 1);
		assert.deepEqual(sensor.inspectors, ['typescript']);
	});

	it('no postWriteDiagnostics → no post-write-diagnostics sensor', () => {
		const { sensors } = buildHarnessManifest({});
		assert.ok(!sensors.some((s) => s.name === 'post-write-diagnostics'));
	});

	it('installResult → dependency-install sensor', () => {
		const state = { installResult: { ok: true } };
		const { sensors } = buildHarnessManifest(state);
		const sensor = sensors.find((s) => s.name === 'dependency-install');
		assert.ok(sensor);
		assert.equal(sensor.type, 'computational');
		assert.equal(sensor.ok, true);
	});

	it('installResult with ok=false → dependency-install sensor ok=false', () => {
		const state = { installResult: { ok: false } };
		const { sensors } = buildHarnessManifest(state);
		const sensor = sensors.find((s) => s.name === 'dependency-install');
		assert.ok(sensor);
		assert.equal(sensor.ok, false);
	});

	it('testResult → verification sensor with command and ok', () => {
		const state = {
			testResult: { command: 'npm test', ok: true },
		};
		const { sensors } = buildHarnessManifest(state);
		const sensor = sensors.find((s) => s.name === 'verification');
		assert.ok(sensor);
		assert.equal(sensor.type, 'computational');
		assert.equal(sensor.command, 'npm test');
		assert.equal(sensor.ok, true);
	});

	it('healingResult → healing-loop sensor with type=both', () => {
		const state = {
			healingResult: {
				repairs: [{ attempt: 1 }, { attempt: 2 }],
				healed: true,
				stopReason: 'max-turns',
			},
		};
		const { sensors } = buildHarnessManifest(state);
		const sensor = sensors.find((s) => s.name === 'healing-loop');
		assert.ok(sensor);
		assert.equal(sensor.type, 'both');
		assert.equal(sensor.turns, 2);
		assert.equal(sensor.healed, true);
		assert.equal(sensor.stopReason, 'max-turns');
	});

	it('json-extraction ok=true when proposalFound=true and no proposalError', () => {
		const state = { proposalFound: true, proposalError: null };
		const { sensors } = buildHarnessManifest(state);
		const sensor = sensors.find((s) => s.name === 'json-extraction');
		assert.equal(sensor.ok, true);
	});

	it('json-extraction ok=false when proposalFound=false', () => {
		const state = { proposalFound: false };
		const { sensors } = buildHarnessManifest(state);
		const sensor = sensors.find((s) => s.name === 'json-extraction');
		assert.equal(sensor.ok, false);
	});

	it('json-extraction ok=false when proposalError is set', () => {
		const state = { proposalFound: true, proposalError: new Error('bad json') };
		const { sensors } = buildHarnessManifest(state);
		const sensor = sensors.find((s) => s.name === 'json-extraction');
		assert.equal(sensor.ok, false);
	});

	// --- Coverage counts ---

	it('mixed state → correct coverage counts', () => {
		const state = {
			// computational guides: repomap, lsp-typescript (2)
			contextPacking: {
				strategy: 'inspection-aware',
				lspInspectors: ['typescript'],
			},
			inspectionIndex: { totalSymbols: 10 },
			// inferential guides: agents-md, session-compaction (2)
			context: { agents: { includedBytes: 100 } },
			sessionCompaction: true,
			// sensors: json-extraction (computational), safe-writes (computational),
			//          verification (computational), healing-loop (both)
			proposalFound: true,
			writeResult: { writes: ['x.ts'], applied: true },
			testResult: { command: 'npm test', ok: false },
			healingResult: { repairs: [{}], healed: false, stopReason: 'errors' },
		};
		const { guides, sensors, coverage } = buildHarnessManifest(state);

		assert.equal(coverage.computationalGuides, 2);
		assert.equal(coverage.inferentialGuides, 2);

		// json-extraction + safe-writes + verification = 3 computational
		// healing-loop (type=both) counts as both computational AND inferential
		assert.equal(coverage.computationalSensors, 4);
		assert.equal(coverage.inferentialSensors, 1);
		assert.equal(coverage.totalControls, guides.length + sensors.length);
	});

	it('healing-loop counts as both computational and inferential in coverage', () => {
		const state = {
			healingResult: { repairs: [], healed: false, stopReason: 'no-errors' },
		};
		const { coverage } = buildHarnessManifest(state);
		// json-extraction + healing-loop(both) → computationalSensors=2
		assert.equal(coverage.computationalSensors, 2);
		// healing-loop(both) → inferentialSensors=1
		assert.equal(coverage.inferentialSensors, 1);
	});
});

// ---------------------------------------------------------------------------
// renderDiagnosticsForModel
// ---------------------------------------------------------------------------

describe('renderDiagnosticsForModel', () => {
	it('null → returns empty string', () => {
		assert.equal(renderDiagnosticsForModel(null), '');
	});

	it('undefined → returns empty string', () => {
		assert.equal(renderDiagnosticsForModel(undefined), '');
	});

	it('no arguments → returns empty string', () => {
		assert.equal(renderDiagnosticsForModel(), '');
	});

	it('empty files array with zero counts → returns empty string', () => {
		assert.equal(
			renderDiagnosticsForModel({ errorCount: 0, warningCount: 0, files: [] }),
			'',
		);
	});

	it('zero errorCount + zero warningCount even with files → returns empty string', () => {
		const report = {
			errorCount: 0,
			warningCount: 0,
			files: [
				{
					path: 'src/foo.ts',
					diagnostics: [{ severity: 'hint', line: 1, message: 'style' }],
				},
			],
		};
		assert.equal(renderDiagnosticsForModel(report), '');
	});

	it('report with errors → includes error lines, suppresses warning-only diagnostics', () => {
		const report = {
			errorCount: 1,
			warningCount: 1,
			files: [
				{
					path: 'src/index.ts',
					diagnostics: [
						{ severity: 'error', line: 10, message: 'Type mismatch' },
						{ severity: 'warning', line: 20, message: 'Unused variable' },
					],
				},
			],
		};
		const result = renderDiagnosticsForModel(report);
		assert.ok(result.includes('Type mismatch'), 'error message should appear');
		assert.ok(
			!result.includes('Unused variable'),
			'warning should be suppressed when errors exist',
		);
		assert.ok(result.includes('src/index.ts:10'));
	});

	it('report with only warnings → shows warnings', () => {
		const report = {
			errorCount: 0,
			warningCount: 2,
			files: [
				{
					path: 'src/utils.ts',
					diagnostics: [
						{ severity: 'warning', line: 5, message: 'Deprecated API' },
						{ severity: 'warning', line: 8, message: 'Any type used' },
					],
				},
			],
		};
		const result = renderDiagnosticsForModel(report);
		assert.ok(result.includes('Deprecated API'));
		assert.ok(result.includes('Any type used'));
		assert.ok(result.includes('warning'));
	});

	it('maxLines option truncates output and appends truncation note', () => {
		const diagnostics = Array.from({ length: 10 }, (_, i) => ({
			severity: 'error',
			line: i + 1,
			message: `Error ${i + 1}`,
		}));
		const report = {
			errorCount: 10,
			warningCount: 0,
			files: [{ path: 'src/big.ts', diagnostics }],
		};
		const result = renderDiagnosticsForModel(report, { maxLines: 3 });
		// Should show first 3 lines
		assert.ok(result.includes('Error 1'));
		assert.ok(result.includes('Error 2'));
		assert.ok(result.includes('Error 3'));
		assert.ok(!result.includes('Error 4'), 'line 4 should be truncated');
		assert.ok(result.includes('…and 7 more'), 'truncation note should appear');
	});

	it('no truncation when lines ≤ maxLines', () => {
		const report = {
			errorCount: 2,
			warningCount: 0,
			files: [
				{
					path: 'src/a.ts',
					diagnostics: [
						{ severity: 'error', line: 1, message: 'First' },
						{ severity: 'error', line: 2, message: 'Second' },
					],
				},
			],
		};
		const result = renderDiagnosticsForModel(report, { maxLines: 5 });
		assert.ok(!result.includes('…and'), 'no truncation note expected');
	});

	it('single error → "1 error" (singular noun)', () => {
		const report = {
			errorCount: 1,
			warningCount: 0,
			files: [
				{
					path: 'src/x.ts',
					diagnostics: [{ severity: 'error', line: 3, message: 'Bad type' }],
				},
			],
		};
		const result = renderDiagnosticsForModel(report);
		assert.ok(result.includes('1 error'), 'should use singular "1 error"');
		assert.ok(
			!result.includes('error(s)'),
			'should not use plural form for single error',
		);
	});

	it('multiple errors → plural noun with (s)', () => {
		const report = {
			errorCount: 3,
			warningCount: 0,
			files: [
				{
					path: 'src/x.ts',
					diagnostics: [
						{ severity: 'error', line: 1, message: 'E1' },
						{ severity: 'error', line: 2, message: 'E2' },
						{ severity: 'error', line: 3, message: 'E3' },
					],
				},
			],
		};
		const result = renderDiagnosticsForModel(report);
		assert.ok(result.includes('3 error(s)'));
	});

	it('single warning → "1 warning" (singular noun)', () => {
		const report = {
			errorCount: 0,
			warningCount: 1,
			files: [
				{
					path: 'src/y.ts',
					diagnostics: [{ severity: 'warning', line: 7, message: 'Old API' }],
				},
			],
		};
		const result = renderDiagnosticsForModel(report);
		assert.ok(result.includes('1 warning'));
		assert.ok(!result.includes('warning(s)'));
	});

	it('result includes trailing fix instruction', () => {
		const report = {
			errorCount: 1,
			warningCount: 0,
			files: [
				{
					path: 'src/z.ts',
					diagnostics: [{ severity: 'error', line: 1, message: 'Oops' }],
				},
			],
		};
		const result = renderDiagnosticsForModel(report);
		assert.ok(result.includes('Fix these before relying on test results'));
	});

	it('diagnostics across multiple files → fileCount reflects distinct files', () => {
		const report = {
			errorCount: 2,
			warningCount: 0,
			files: [
				{
					path: 'src/a.ts',
					diagnostics: [{ severity: 'error', line: 1, message: 'E1' }],
				},
				{
					path: 'src/b.ts',
					diagnostics: [{ severity: 'error', line: 2, message: 'E2' }],
				},
			],
		};
		const result = renderDiagnosticsForModel(report);
		assert.ok(result.includes('2 file(s)'));
	});

	it('single file with errors → "1 file" (singular)', () => {
		const report = {
			errorCount: 1,
			warningCount: 0,
			files: [
				{
					path: 'src/single.ts',
					diagnostics: [{ severity: 'error', line: 1, message: 'Boom' }],
				},
			],
		};
		const result = renderDiagnosticsForModel(report);
		assert.ok(result.includes('1 file'));
		assert.ok(!result.includes('1 file(s)'));
	});

	it('file with no diagnostics array → does not throw', () => {
		const report = {
			errorCount: 1,
			warningCount: 0,
			files: [
				{ path: 'src/nodx.ts' }, // no diagnostics property
				{
					path: 'src/real.ts',
					diagnostics: [{ severity: 'error', line: 1, message: 'Real error' }],
				},
			],
		};
		assert.doesNotThrow(() => renderDiagnosticsForModel(report));
		const result = renderDiagnosticsForModel(report);
		assert.ok(result.includes('Real error'));
	});

	it('default maxLines is 30 — does not truncate 30 lines', () => {
		const diagnostics = Array.from({ length: 30 }, (_, i) => ({
			severity: 'error',
			line: i + 1,
			message: `Err${i + 1}`,
		}));
		const report = {
			errorCount: 30,
			warningCount: 0,
			files: [{ path: 'src/many.ts', diagnostics }],
		};
		const result = renderDiagnosticsForModel(report);
		assert.ok(!result.includes('…and'), 'exactly 30 lines should not truncate');
	});

	it('default maxLines is 30 — truncates at 31 lines', () => {
		const diagnostics = Array.from({ length: 31 }, (_, i) => ({
			severity: 'error',
			line: i + 1,
			message: `Err${i + 1}`,
		}));
		const report = {
			errorCount: 31,
			warningCount: 0,
			files: [{ path: 'src/many.ts', diagnostics }],
		};
		const result = renderDiagnosticsForModel(report);
		assert.ok(result.includes('…and 1 more'));
	});
});
