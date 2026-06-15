import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { describe, it } from 'node:test';
import {
	DECODE_ARTIFACT_RULES,
	extractJson,
	extractProposal,
	findJsonText,
} from '../src/json-extractor.mjs';

// Helper: resolve fixture paths relative to this file's directory.
const fixtureDir = new URL('../test/fixtures/', import.meta.url);
function fixturePath(name) {
	return new URL(name, fixtureDir).pathname;
}

describe('extractJson', () => {
	it('extracts prose-wrapped JSON', () => {
		const value = extractJson(
			'Here is the answer:\n{"ok":true,"count":2}\nThanks.',
		);

		assert.deepEqual(value, {
			count: 2,
			ok: true,
		});
	});

	it('strips markdown JSON fences', () => {
		const value = extractJson('```json\n{"files":[]}\n```');

		assert.deepEqual(value, {
			files: [],
		});
	});

	it('handles braces inside strings', () => {
		const text =
			'prefix {"message":"keep { this } as text","done":true} suffix';

		assert.deepEqual(extractJson(text), {
			done: true,
			message: 'keep { this } as text',
		});
		assert.equal(
			findJsonText(text),
			'{"message":"keep { this } as text","done":true}',
		);
	});

	it('repairs raw newlines in JSON strings', () => {
		const value = extractJson('{"text":"line one\nline two"}');

		assert.deepEqual(value, {
			text: 'line one\nline two',
		});
	});

	it('repairs escaped backticks from markdown-heavy model output', () => {
		const value = extractJson('{"code":"\\`\\`\\`js\\n1 + 1\\n\\`\\`\\`"}');

		assert.deepEqual(value, {
			code: '```js\n1 + 1\n```',
		});
	});

	it('repairs invalid single-quote escapes inside JSON strings', () => {
		const value = extractJson(
			'{"code":"document.getElementById(\\\'game\\\')"}',
		);

		assert.deepEqual(value, {
			code: "document.getElementById('game')",
		});
	});

	it('rejects duplicate top-level keys instead of keeping the last value', () => {
		assert.throws(
			() => extractJson('{"files":[{"path":"a","content":"x"}],"files":[]}'),
			/Duplicate JSON key: files/u,
		);
	});

	it('parses fixture-like text captured from response.md artifacts', () => {
		const responseMarkdown = `I will update one file.

\`\`\`json
{
  "files": [
    {
      "path": "README.md",
      "content": "hello {world}
"
    }
  ]
}
\`\`\`
`;

		assert.deepEqual(extractJson(responseMarkdown), {
			files: [
				{
					content: 'hello {world}\n',
					path: 'README.md',
				},
			],
		});
	});
});

// E1: candidate enumeration never aborts on braceWalk errors
describe('extractJson — E1: braceWalk errors do not abort enumeration', () => {
	it('extracts a valid fenced block even when a prose brace region is malformed', () => {
		// The prose region has mismatched braces; the fenced block is valid.
		const text = [
			'Malformed: {"key": "unclosed',
			'```json',
			'{"status":"OK","files":[],"patches":[],"messages":[]}',
			'```',
		].join('\n');

		// Should not throw — malformed brace region is skipped, fenced block wins.
		const value = extractJson(text);
		assert.deepEqual(value, {
			files: [],
			messages: [],
			patches: [],
			status: 'OK',
		});
	});

	it('extracts a valid JSON object that appears after a garbage brace region', () => {
		// First { starts an unclosed region; second { starts a valid object.
		const text = 'garbage {{{{{{{ {"ok":true}';
		const value = extractJson(text);
		assert.equal(value.ok, true);
	});
});

// E3: duplicate-key detection at all depths
describe('extractJson — E3: duplicate key detection at all depths', () => {
	it('rejects duplicate top-level keys', () => {
		assert.throws(() => extractJson('{"a":1,"a":2}'), /Duplicate JSON key: a/u);
	});

	it('repairs duplicate keys nested inside an array element object (R3 split rule)', () => {
		// Phase 118: the qwen duplicate-key-cluster split rule (R3) converts
		// {"path":"a.mjs","path":"b.mjs","content":"x"} into two separate objects.
		// extractJson now repairs rather than rejecting this pattern.
		const result = extractJson(
			'{"files":[{"path":"a.mjs","path":"b.mjs","content":"x"}]}',
		);
		assert.deepEqual(result, {
			files: [{ path: 'a.mjs' }, { path: 'b.mjs', content: 'x' }],
		});
	});

	it('rejects duplicate keys in nested objects', () => {
		assert.throws(
			() => extractJson('{"outer":{"inner":1,"inner":2}}'),
			/Duplicate JSON key: inner/u,
		);
	});

	it('allows same key at different nesting depths', () => {
		// "path" appears as a key at depth 1 and as a key in a nested object —
		// these are different objects so no duplication.
		const value = extractJson(
			'{"path":"top","nested":{"path":"deep"},"files":[]}',
		);
		assert.equal(value.path, 'top');
		assert.equal(value.nested.path, 'deep');
	});
});

// E5: fenced block enumeration — the gemma-4 response.md fixture
describe('fencedJsonBlocks — E5: all six blocks are enumerated', () => {
	// Fixture derived from the real gemma-4 response artifact at:
	// ~/src/kodr-testing/phase-111/gemma-smoke-1/.kodr/runs/2026-06-12T06-28-30.378Z/response.md
	// The response emits six consecutive ```json blocks with no closing ``` between them
	// except the final one. The old regex-based extractor matched only three blocks.
	// The line-anchored state-machine extractor must enumerate all six.
	const gemmaFixture = `\`\`\`json
{"status":"OK","messages":[{"level":"info","content":"Planning"}],"files":[],"patches":[],"scratchpad":"Plan: step 1"}
\`\`\`json
{"status":"OK","messages":[{"level":"info","content":"Creating wordfreq.mjs"}],"files":[{"path":"wordfreq.mjs","content":"export function f() {}"}],"patches":[],"scratchpad":""}
\`\`\`json
{"status":"OK","messages":[{"level":"info","content":"Creating test/wordfreq.test.mjs"}],"files":[{"path":"test/wordfreq.test.mjs","content":"import assert from 'node:assert';"}],"patches":[],"scratchpad":""}
\`\`\`json
{"status":"OK","messages":[{"level":"info","content":"Running tests"}],"files":[],"patches":[],"scratchpad":""}
\`\`\`json
{"status":"OK","messages":[{"level":"info","content":"Tests passed"}],"files":[],"patches":[],"scratchpad":""}
\`\`\`json
{"status":"OK","messages":[{"level":"info","content":"Finalizing"}],"files":[],"patches":[],"scratchpad":""}
\`\`\``;

	it('extracts a proposal containing the real files from blocks 2+', () => {
		const proposal = extractProposal(gemmaFixture);
		assert.ok(proposal, 'proposal should not be null');
		const paths = proposal.files.map((f) => f.path);
		assert.ok(
			paths.includes('wordfreq.mjs'),
			'wordfreq.mjs should be in proposal',
		);
		assert.ok(
			paths.includes('test/wordfreq.test.mjs'),
			'test/wordfreq.test.mjs should be in proposal',
		);
	});

	it('extraction metadata reports multiple proposals were merged', () => {
		const proposal = extractProposal(gemmaFixture);
		assert.ok(
			proposal._extractionMeta,
			'extraction metadata should be present',
		);
		assert.equal(proposal._extractionMeta.merged, true);
		assert.ok(
			proposal._extractionMeta.proposalCount >= 2,
			'at least 2 proposal envelopes should be found',
		);
	});
});

// E2: multi-candidate proposal merge
describe('extractProposal — E2: multi-envelope merge', () => {
	it('returns a single envelope unchanged', () => {
		const text =
			'```json\n{"status":"OK","files":[{"path":"a.mjs","content":"x"}],"patches":[],"messages":[]}\n```';
		const proposal = extractProposal(text);
		assert.ok(proposal);
		assert.equal(proposal.files.length, 1);
		assert.equal(proposal.files[0].path, 'a.mjs');
		assert.equal(proposal._extractionMeta.merged, false);
		assert.equal(proposal._extractionMeta.proposalCount, 1);
	});

	it('merges files from two envelopes — last-wins per path', () => {
		// Block 1: planning envelope with empty files (same pattern as gemma-4 block 1).
		// Block 2: real file content.
		const text = [
			'```json',
			'{"status":"OK","files":[],"patches":[],"messages":[{"level":"info","content":"planning"}],"scratchpad":"plan"}',
			'```json',
			'{"status":"OK","files":[{"path":"main.mjs","content":"console.log(1)"}],"patches":[],"messages":[{"level":"info","content":"writing"}],"scratchpad":""}',
			'```',
		].join('\n');

		const proposal = extractProposal(text);
		assert.ok(proposal, 'proposal should not be null');
		assert.equal(proposal.files.length, 1);
		assert.equal(proposal.files[0].path, 'main.mjs');
	});

	it('concatenates messages from all envelopes in document order', () => {
		const text = [
			'```json',
			'{"status":"OK","files":[],"patches":[],"messages":[{"level":"info","content":"step 1"}]}',
			'```json',
			'{"status":"OK","files":[],"patches":[],"messages":[{"level":"info","content":"step 2"}]}',
			'```',
		].join('\n');

		const proposal = extractProposal(text);
		assert.ok(proposal);
		assert.equal(proposal.messages.length, 2);
		assert.equal(proposal.messages[0].content, 'step 1');
		assert.equal(proposal.messages[1].content, 'step 2');
	});

	it('takes status and scratchpad from the last envelope that sets them', () => {
		const text = [
			'```json',
			'{"status":"OK","files":[],"patches":[],"messages":[],"scratchpad":"first plan"}',
			'```json',
			'{"status":"OK","files":[],"patches":[],"messages":[],"scratchpad":"final plan"}',
			'```',
		].join('\n');

		const proposal = extractProposal(text);
		assert.ok(proposal);
		assert.equal(proposal.scratchpad, 'final plan');
	});

	it('records candidateCount in extraction metadata', () => {
		const text =
			'```json\n{"status":"OK","files":[],"patches":[],"messages":[]}\n```';
		const proposal = extractProposal(text);
		assert.ok(proposal._extractionMeta);
		assert.equal(typeof proposal._extractionMeta.candidateCount, 'number');
		assert.ok(proposal._extractionMeta.candidateCount >= 1);
	});

	it('returns null when no candidate parses as a proposal envelope', () => {
		const result = extractProposal('{"not":"a proposal"}');
		assert.equal(result, null);
	});

	it('returns null for non-string input', () => {
		assert.equal(extractProposal(null), null);
		assert.equal(extractProposal(undefined), null);
		assert.equal(extractProposal(42), null);
	});
});

describe('repairJsonText — S3: decode-artifact pseudo-token repair', () => {
	// Provenance: google/gemma-4-26b-a4b on LM Studio emits the literal token
	// <|"|> in place of escaped/closing quotes inside JSON string values. Confirmed
	// in ~/src/kodr-testing/phase-111/gemma-smoke-2/.kodr/runs/2026-06-12T06-54-00.966Z/response.md
	// (7 occurrences, every fenced envelope corrupted). The fixture below reproduces
	// the pattern from that response.
	it('replaces <|"|> pseudo-token with a real quote in a JSON string', () => {
		// Simulated gemma-4 output: closing quote of the "content" string value is
		// replaced by <|"|>, so the JSON is malformed. After repair it parses.
		// Pattern: "content": "code here<|"|>  →  "content": "code here"
		const gemmaArtifact =
			'```json\n' +
			'{\n' +
			'  "status": "OK",\n' +
			'  "messages": [],\n' +
			'  "files": [{"path": "src/index.mjs", "content": "console.log(42);<|"|>}],\n' +
			'  "patches": [],\n' +
			'  "scratchpad": "done"\n' +
			'}\n' +
			'```';

		// After repair, <|"|> becomes " so the JSON parses correctly.
		const result = extractJson(gemmaArtifact);
		assert.ok(result, 'should extract JSON after decode-artifact repair');
		assert.ok(
			Array.isArray(result.files),
			'files array should be present after repair',
		);
		assert.equal(result.files[0].path, 'src/index.mjs');
		assert.equal(result.files[0].content, 'console.log(42);');
	});

	it('repairs closing <|"|> that replaces the structural closing quote', () => {
		// In real gemma-4 output, <|"|> substitutes for a structural " in the JSON
		// syntax — typically the closing quote of a string value. After repair the
		// JSON becomes valid and parses normally.
		// Example pattern: "content": "some code<|"|> → "content": "some code"
		const text = '{"key": "hello world<|"|>, "other": "value"}';
		// After replacement: {"key": "hello world", "other": "value"}
		const result = extractJson(text);
		assert.equal(result.key, 'hello world');
		assert.equal(result.other, 'value');
	});

	it('repairs a complete gemma-style proposal envelope containing <|"|> artifacts', () => {
		// Pattern from gemma-smoke-2: closing structural quotes replaced by <|"|>.
		// "status": "OK<|"|>  →  "status": "OK"
		const envelope =
			'```json\n' +
			'{"status":"OK<|"|>,"messages":[],"files":[],"patches":[],"scratchpad":"done<|"|>}\n' +
			'```';

		const proposal = extractProposal(envelope);
		assert.ok(proposal, 'should extract proposal after decode-artifact repair');
		assert.equal(proposal.status, 'OK');
		assert.equal(proposal.scratchpad, 'done');
	});
});

// Phase 115: structural decode-artifact rules
// R1 — gemma collapsed-key rule
describe('repairJsonText — R1: gemma collapsed-key structural rule', () => {
	// Provenance: ~/src/kodr-testing/phase-113/greenfield-logstats-1/.kodr/runs/2026-06-12T09-22-36.855Z/raw-response.json
	// gemma collapses "key":"  into  "key:<|"|> — the blanket rule alone cannot fix this.

	it('repairs "key:<|"|> collapsed artifact into "key":"', () => {
		// After R1: "content:<|"|>  →  "content":"
		// The blanket rule would have yielded "content:" (unquoted value) — still malformed.
		const text =
			'{"status":"OK","files":[{"path":"a.mjs","content:<|"|>console.log(1)"}],"patches":[],"messages":[],"scratchpad":""}';
		const proposal = extractProposal(text);
		assert.ok(proposal, 'proposal should be extracted after R1 repair');
		assert.equal(proposal.files.length, 1);
		assert.equal(proposal.files[0].path, 'a.mjs');
		assert.equal(proposal.files[0].content, 'console.log(1)');
	});

	it('R1 fires before the blanket <|"|> rule so the key separator is not mangled', () => {
		// If blanket fired first: "content:<|"|> → "content:" — value still unquoted.
		// R1 must fire first: "content:<|"|> → "content":"
		const text =
			'{"status":"OK","files":[{"path":"x.mjs","content:<|"|>x"}],"patches":[],"messages":[],"scratchpad":""}';
		const proposal = extractProposal(text);
		assert.ok(
			proposal,
			'structural ordering should allow R1 to fix the separator',
		);
		assert.equal(proposal.files[0].content, 'x');
	});

	it('does not fire on valid JSON that already parses (no false positive)', () => {
		// A valid envelope must parse cleanly without structural mutation.
		const valid = JSON.stringify({
			status: 'OK',
			files: [{ path: 'ok.mjs', content: 'good' }],
			patches: [],
			messages: [],
			scratchpad: '',
		});
		const proposal = extractProposal(valid);
		assert.ok(proposal);
		assert.equal(proposal.files[0].content, 'good');
		// No structural repairs should have fired.
		assert.equal(proposal._extractionMeta.repairs, undefined);
	});
});

// R2 — gpt-oss array-boundary structural rules
describe('repairJsonText — R2: gpt-oss array-boundary structural rules', () => {
	// Provenance (R2a stray quote):
	//   ~/src/kodr-testing/phase-113/transport-validation-gptoss/.kodr/runs/2026-06-12T11-41-44.327Z/raw-response.json
	// Provenance (R2b missing brace, twice):
	//   ~/src/kodr-testing/phase-114/ab-gptoss-newprompt/.kodr/runs/2026-06-12T12-07-32.733Z/raw-response.json
	//   ~/src/kodr-testing/phase-114/ab2-gptoss/.kodr/runs/2026-06-12T12-25-15.658Z/raw-response.json

	it('R2a: repairs stray-quote boundary },"{ → },{', () => {
		// Observed: "},"{" between two files[] objects.
		const text =
			'{"status":"OK","files":[{"path":"a.mjs","content":"x"},"{"path":"b.mjs","content":"y"}],"patches":[],"messages":[],"scratchpad":""}';
		const proposal = extractProposal(text);
		assert.ok(proposal, 'proposal should be extracted after R2a repair');
		const paths = proposal.files.map((f) => f.path);
		assert.ok(paths.includes('a.mjs'), 'a.mjs should be present');
		assert.ok(paths.includes('b.mjs'), 'b.mjs should be present');
		assert.ok(
			proposal._extractionMeta.repairs?.some(
				(r) => r.ruleId === 'gpt-oss-stray-quote',
			),
			'gpt-oss-stray-quote repair should be recorded',
		);
	});

	it('R2b: repairs missing-brace boundary },"key": → },{"key":', () => {
		// Observed: "},"path":" between two files[] objects.
		const text =
			'{"status":"OK","files":[{"path":"a.mjs","content":"x"},"path":"b.mjs","content":"y"}],"patches":[],"messages":[],"scratchpad":""}';
		const proposal = extractProposal(text);
		assert.ok(proposal, 'proposal should be extracted after R2b repair');
		const paths = proposal.files.map((f) => f.path);
		assert.ok(paths.includes('a.mjs'), 'a.mjs should be present');
		assert.ok(paths.includes('b.mjs'), 'b.mjs should be present');
		assert.ok(
			proposal._extractionMeta.repairs?.some(
				(r) => r.ruleId === 'gpt-oss-missing-brace',
			),
			'gpt-oss-missing-brace repair should be recorded',
		);
	});

	it('valid envelope containing },"path": inside a STRING VALUE is not corrupted', () => {
		// The structural repair must only fire in the repair path (after a parse failure).
		// A valid envelope with the pattern inside a string value must round-trip cleanly.
		const valid = JSON.stringify({
			status: 'OK',
			files: [
				{
					path: 'test.mjs',
					content: 'the pattern },"path": appears inside this string value',
				},
			],
			patches: [],
			messages: [],
			scratchpad: '',
		});
		const proposal = extractProposal(valid);
		assert.ok(proposal);
		assert.equal(proposal.files.length, 1);
		assert.equal(
			proposal.files[0].content,
			'the pattern },"path": appears inside this string value',
		);
		// No structural repairs should fire on valid JSON.
		assert.equal(proposal._extractionMeta.repairs, undefined);
	});
});

// R3 — _extractionMeta.repairs
describe('extractProposal — R3: _extractionMeta.repairs', () => {
	it('repairs array is absent when no rules fired', () => {
		const text =
			'```json\n{"status":"OK","files":[],"patches":[],"messages":[]}\n```';
		const proposal = extractProposal(text);
		assert.ok(proposal);
		assert.equal(proposal._extractionMeta.repairs, undefined);
	});

	it('repairs array records blanket-quote-token when <|"|> tokens are present', () => {
		// Pattern: <|"|> substitutes for a structural closing quote.
		// "status":"OK<|"|>  →  "status":"OK"
		const text =
			'{"status":"OK<|"|>,"files":[],"patches":[],"messages":[],"scratchpad":"<|"|>}';
		const proposal = extractProposal(text);
		assert.ok(proposal);
		const repairs = proposal._extractionMeta.repairs;
		assert.ok(Array.isArray(repairs), 'repairs should be an array');
		const blanket = repairs.find((r) => r.ruleId === 'blanket-quote-token');
		assert.ok(blanket, 'blanket-quote-token entry should be present');
		assert.ok(blanket.count >= 1, 'count should be at least 1');
	});

	it('repairs array records structural rule when it fires', () => {
		const text =
			'{"status":"OK","files":[{"path":"a.mjs","content:<|"|>x"}],"patches":[],"messages":[],"scratchpad":""}';
		const proposal = extractProposal(text);
		assert.ok(proposal);
		const repairs = proposal._extractionMeta.repairs;
		assert.ok(Array.isArray(repairs));
		const structural = repairs.find((r) => r.ruleId === 'gemma-collapsed-key');
		assert.ok(structural, 'gemma-collapsed-key entry should be present');
		assert.equal(structural.count, 1);
	});
});

// R5 — offline replay of real corrupt responses, driven by the corpus manifest.
// Each fixture is a verbatim model response captured under ~/src/kodr-testing/;
// the manifest (test/fixtures/corpus.json) records its provenance, failure mode,
// expected recovered paths, and expected repair ruleIds. Growth = drop a .txt
// and add a manifest row — no new test code (phase 123).
const replayCorpus = JSON.parse(
	await readFile(fixturePath('corpus.json'), 'utf8'),
);

describe('extractProposal — R5: offline replay corpus (manifest-driven)', () => {
	it('manifest is honest: every fixture file exists and ids are unique', async () => {
		const ids = new Set();
		for (const entry of replayCorpus) {
			assert.ok(!ids.has(entry.id), `duplicate corpus id: ${entry.id}`);
			ids.add(entry.id);
			const content = await readFile(fixturePath(entry.file), 'utf8');
			assert.ok(content.length > 0, `${entry.file} should be non-empty`);
		}
		assert.ok(replayCorpus.length >= 5, 'corpus should hold at least 5 cases');
	});

	for (const entry of replayCorpus) {
		it(`${entry.id}: recovers ${entry.expectedPaths.join(', ')} (${entry.failureMode})`, async () => {
			const content = await readFile(fixturePath(entry.file), 'utf8');
			const proposal = extractProposal(content);
			assert.ok(proposal, `${entry.id}: proposal should not be null`);
			const paths = proposal.files.map((f) => f.path);
			for (const expected of entry.expectedPaths) {
				assert.ok(
					paths.includes(expected),
					`${entry.id}: expected ${expected} in [${paths.join(', ')}]`,
				);
			}
			const repairIds = (proposal._extractionMeta?.repairs || []).map(
				(r) => r.ruleId,
			);
			for (const expected of entry.expectedRepairs) {
				assert.ok(
					repairIds.includes(expected),
					`${entry.id}: expected repair ${expected} in [${repairIds.join(', ')}]`,
				);
			}
		});
	}
});

// DECODE_ARTIFACT_RULES export — rule ordering
describe('DECODE_ARTIFACT_RULES — exported rule ordering', () => {
	it('gemma-collapsed-key appears before blanket-quote-token', () => {
		const ids = DECODE_ARTIFACT_RULES.map((r) => r.ruleId);
		const collapsedIdx = ids.indexOf('gemma-collapsed-key');
		const blanketIdx = ids.indexOf('blanket-quote-token');
		assert.ok(collapsedIdx !== -1, 'gemma-collapsed-key should be in rules');
		assert.ok(blanketIdx !== -1, 'blanket-quote-token should be in rules');
		assert.ok(
			collapsedIdx < blanketIdx,
			'gemma-collapsed-key must precede blanket-quote-token',
		);
	});

	it('all structural rules precede blanket rules', () => {
		let lastStructural = -1;
		let firstBlanket = Infinity;
		DECODE_ARTIFACT_RULES.forEach((r, i) => {
			if (r.type === 'structural') lastStructural = i;
			if (r.type === 'blanket' && i < firstBlanket) firstBlanket = i;
		});
		assert.ok(
			firstBlanket !== Infinity,
			'there should be at least one blanket rule',
		);
		assert.ok(
			lastStructural < firstBlanket,
			'all structural rules should precede all blanket rules',
		);
	});

	it('each rule has a unique stable ruleId', () => {
		const ids = DECODE_ARTIFACT_RULES.map((r) => r.ruleId);
		const unique = new Set(ids);
		assert.equal(unique.size, ids.length, 'all ruleIds should be unique');
	});

	it('qwen-duplicate-key-cluster is in the rule list between gpt-oss rules and blanket rules', () => {
		const ids = DECODE_ARTIFACT_RULES.map((r) => r.ruleId);
		const clusterIdx = ids.indexOf('qwen-duplicate-key-cluster');
		const blanketIdx = ids.indexOf('blanket-quote-token');
		assert.ok(
			clusterIdx !== -1,
			'qwen-duplicate-key-cluster should be in rules',
		);
		assert.ok(
			clusterIdx < blanketIdx,
			'qwen-duplicate-key-cluster must precede blanket rules',
		);
	});
});

// ---------------------------------------------------------------------------
// T5 — R3: qwen duplicate-key-cluster split rule
// Provenance: qwen/qwen3.6-35b-a3b phase-117 validation run.
// Fixture: test/fixtures/qwen-duplicate-path-key.txt
// (extracted from ~/src/kodr-testing/phase-117/greenfield-wordfreq-qwen/
//  .kodr/runs/2026-06-13T01-09-47.682Z/raw-response.json —
//  responses[-1].choices[0].message.content)
// ---------------------------------------------------------------------------
describe('R3: qwen duplicate-key-cluster split rule', () => {
	it('splits a simple two-key duplicate into two objects', () => {
		const result = extractProposal(
			'{"files":[{"path":"a.mjs","content":"aaa","path":"b.mjs","content":"bbb"}]}',
		);
		assert.ok(result !== null, 'should extract a proposal');
		assert.equal(result.files.length, 2);
		assert.equal(result.files[0].path, 'a.mjs');
		assert.equal(result.files[0].content, 'aaa');
		assert.equal(result.files[1].path, 'b.mjs');
		assert.equal(result.files[1].content, 'bbb');
		// ruleId recorded in repairs
		assert.ok(
			result._extractionMeta.repairs?.some(
				(r) => r.ruleId === 'qwen-duplicate-key-cluster',
			),
			'qwen-duplicate-key-cluster repair should be recorded',
		);
	});

	it('no-false-positive: string value containing ,"path": is untouched', () => {
		// The pattern ,"path": inside a string value must not be split.
		const input =
			'{"files":[{"path":"a.mjs","content":"the key ,\\"path\\": is inside the value"}]}';
		const result = extractProposal(input);
		assert.ok(result !== null, 'should extract a proposal');
		assert.equal(result.files.length, 1);
		assert.equal(result.files[0].path, 'a.mjs');
		assert.match(result.files[0].content, /inside the value/u);
	});

	it('no-false-positive: same key in different (sibling) objects is not split', () => {
		// Two separate objects in the files array both have "path" — that is valid.
		const input =
			'{"files":[{"path":"a.mjs","content":"x"},{"path":"b.mjs","content":"y"}]}';
		const result = extractProposal(input);
		assert.ok(result !== null, 'should extract a proposal');
		assert.equal(result.files.length, 2);
		// No repair needed
		assert.ok(
			!result._extractionMeta.repairs?.some(
				(r) => r.ruleId === 'qwen-duplicate-key-cluster',
			),
			'qwen-duplicate-key-cluster should NOT fire on separate sibling objects',
		);
	});

	it('offline replay: qwen fixture extracts both files with expected paths', async () => {
		// Provenance: ~/src/kodr-testing/phase-117/greenfield-wordfreq-qwen/
		//   .kodr/runs/2026-06-13T01-09-47.682Z/raw-response.json
		// responses[-1].choices[0].message.content — embedded as a test fixture.
		const content = await readFile(
			fixturePath('qwen-duplicate-path-key.txt'),
			'utf8',
		);
		const result = extractProposal(content);
		assert.ok(
			result !== null,
			'should extract a proposal from the qwen fixture',
		);
		const paths = result.files.map((f) => f.path);
		assert.ok(
			paths.includes('wordfreq.mjs'),
			`expected wordfreq.mjs in extracted paths, got: ${paths.join(', ')}`,
		);
		assert.ok(
			paths.includes('test/wordfreq.test.mjs'),
			`expected test/wordfreq.test.mjs in extracted paths, got: ${paths.join(', ')}`,
		);
		assert.equal(result.files.length, 2, 'should extract exactly 2 files');
		// R3 repair should be recorded
		assert.ok(
			result._extractionMeta.repairs?.some(
				(r) => r.ruleId === 'qwen-duplicate-key-cluster',
			),
			'qwen-duplicate-key-cluster repair should be recorded for the qwen fixture',
		);
	});
});

// ---------------------------------------------------------------------------
// R4 — gpt-oss unclosed-file-object structural repair rule (phase 137)
// Provenance: openai/gpt-oss-20b, ~/src/kodr-testing/phase-137/
//   gptoss-truncated-envelope.json (975 bytes). The file object's closing }
//   is missing before the files array ]. Raw wire failed JSON.parse at char 944;
//   response.md looked valid (normalized rendering hid the truncation).
// ---------------------------------------------------------------------------
describe('R4: gpt-oss-unclosed-file-object structural repair rule', () => {
	it('recovers a truncated envelope: 1 file at src/store.mjs, no {"0":...} artifact', async () => {
		const content = await readFile(
			fixturePath('gptoss-file-object-unclosed.txt'),
			'utf8',
		);
		const proposal = extractProposal(content);
		assert.ok(proposal, 'proposal should not be null');
		assert.equal(proposal.files.length, 1, 'should recover exactly 1 file');
		assert.equal(
			proposal.files[0].path,
			'src/store.mjs',
			'recovered file path should be src/store.mjs',
		);
		// The junk {"0":...} artifact must not appear.
		assert.ok(
			!('0' in proposal),
			'proposal must not contain a "0" key (no junk array-as-object)',
		);
		// Repair should be recorded.
		const repairIds = (proposal._extractionMeta?.repairs || []).map(
			(r) => r.ruleId,
		);
		assert.ok(
			repairIds.includes('gpt-oss-unclosed-file-object'),
			`gpt-oss-unclosed-file-object repair should be recorded; got: [${repairIds.join(', ')}]`,
		);
	});

	it('direct extractJson on the capture does not return {"0":...} junk', async () => {
		const content = await readFile(
			fixturePath('gptoss-file-object-unclosed.txt'),
			'utf8',
		);
		// Before the fix, extractJson returned the messages array parsed as {"0":{level,content}}.
		// After the fix, it should return the real envelope with a files array.
		const result = extractJson(content);
		assert.ok(
			!('0' in result),
			'extractJson must not return an array-as-object with key "0"',
		);
		assert.ok(
			Array.isArray(result.files),
			'extractJson should return an object with a files array',
		);
		assert.equal(result.files.length, 1, 'should extract 1 file');
	});

	it('idempotent on a valid envelope (does not alter already-valid JSON)', () => {
		const valid = JSON.stringify({
			status: 'OK',
			files: [{ path: 'a.mjs', content: 'export default 1;' }],
			patches: [],
			messages: [],
			scratchpad: '',
		});
		const proposal = extractProposal(valid);
		assert.ok(proposal, 'valid envelope should still extract correctly');
		assert.equal(proposal.files.length, 1);
		assert.equal(proposal.files[0].path, 'a.mjs');
		// No structural repairs should fire on valid JSON.
		const hasUnclosedRepair = proposal._extractionMeta?.repairs?.some(
			(r) => r.ruleId === 'gpt-oss-unclosed-file-object',
		);
		assert.ok(
			!hasUnclosedRepair,
			'gpt-oss-unclosed-file-object must NOT fire on valid JSON',
		);
	});

	it('does not insert spurious } in a string array like ["a","b"]', () => {
		// A string array has no unclosed objects — the rule must not alter it.
		const stringArray =
			'{"status":"OK","files":[],"patches":[],"messages":[],"tags":["a","b","c"]}';
		const proposal = extractProposal(stringArray);
		assert.ok(proposal, 'string-array envelope should extract correctly');
		// No unclosed-file-object repair.
		const hasUnclosedRepair = proposal._extractionMeta?.repairs?.some(
			(r) => r.ruleId === 'gpt-oss-unclosed-file-object',
		);
		assert.ok(
			!hasUnclosedRepair,
			'gpt-oss-unclosed-file-object must NOT fire on a string array',
		);
	});
});

// ---------------------------------------------------------------------------
// R6 — truncated-envelope-tail structural repair rule (phase 147)
// Provenance: qwen/qwen3.6-35b-a3b, 2026-06-15 examples-trial.
//   ~/src/kodr-testing/md-converter-qwen/.kodr/runs/2026-06-14T21-02-23.704Z/
//   raw-response.json (responses[-1].choices[0].message.content, 6763 chars).
//   Token-limit truncation: files emitted as a duplicate-key cluster, then the
//   files array ] and root } are absent and a stray </parameter> token trails
//   the last }. summary.json: proposalFound:false, ProposalMissingError.
// ---------------------------------------------------------------------------
describe('R6: truncated-envelope-tail structural repair rule', () => {
	it('recovers all four files from the real truncated qwen capture', async () => {
		const content = await readFile(
			fixturePath('qwen-truncated-envelope.txt'),
			'utf8',
		);
		const proposal = extractProposal(content);
		assert.ok(proposal, 'proposal should not be null');
		const paths = proposal.files.map((f) => f.path);
		assert.equal(proposal.files.length, 4, 'should recover exactly 4 files');
		for (const expected of [
			'src/tokenizer.mjs',
			'src/renderer.mjs',
			'test/tokenizer.test.mjs',
			'test/renderer.test.mjs',
		]) {
			assert.ok(paths.includes(expected), `expected ${expected} in recovered`);
		}
		for (const file of proposal.files) {
			assert.ok(
				file.content.length > 0,
				`${file.path} content should be non-empty`,
			);
		}
		// This capture needs both R5 (split the cluster) and R6 (close the tail).
		const repairIds = (proposal._extractionMeta?.repairs || []).map(
			(r) => r.ruleId,
		);
		assert.ok(
			repairIds.includes('truncated-envelope-tail'),
			`truncated-envelope-tail should be recorded; got [${repairIds.join(', ')}]`,
		);
		assert.ok(
			repairIds.includes('qwen-duplicate-key-cluster'),
			`qwen-duplicate-key-cluster should be recorded; got [${repairIds.join(', ')}]`,
		);
	});

	it('extractJson recovers a pure truncation (array ] and root } absent)', () => {
		// No duplicate keys — extractJson alone recovers this via its R4+R6 pre-pass.
		const truncated = '{"status":"OK","files":[{"path":"a.mjs","content":"x"}';
		const result = extractJson(truncated);
		assert.ok(Array.isArray(result.files), 'files array should be present');
		assert.equal(result.files.length, 1, 'should recover the one closed file');
		assert.equal(result.files[0].path, 'a.mjs');
		assert.equal(result.files[0].content, 'x');
	});

	it('recovers a multi-file pure truncation with trailing garbage', () => {
		// Two complete objects, array ] and root } absent, plus a stray tag.
		const truncated =
			'{"status":"OK","files":[{"path":"a.mjs","content":"x"},{"path":"b.mjs","content":"y"}\n</parameter>';
		const proposal = extractProposal(truncated);
		assert.ok(proposal, 'proposal should not be null');
		assert.equal(proposal.files.length, 2);
		assert.deepEqual(
			proposal.files.map((f) => f.path),
			['a.mjs', 'b.mjs'],
		);
		assert.ok(
			proposal._extractionMeta.repairs?.some(
				(r) => r.ruleId === 'truncated-envelope-tail',
			),
			'truncated-envelope-tail should be recorded',
		);
	});

	it('idempotent on a valid envelope (does not fire)', () => {
		const valid = JSON.stringify({
			status: 'OK',
			files: [{ path: 'a.mjs', content: 'export default 1;' }],
			patches: [],
			messages: [],
			scratchpad: '',
		});
		const proposal = extractProposal(valid);
		assert.ok(proposal);
		assert.equal(proposal.files.length, 1);
		const fired = proposal._extractionMeta?.repairs?.some(
			(r) => r.ruleId === 'truncated-envelope-tail',
		);
		assert.ok(!fired, 'truncated-envelope-tail must NOT fire on valid JSON');
	});

	it('does not fire on prose-wrapped valid JSON (trailing prose, not garbage)', () => {
		// The trailing prose is at depth 0 (stack empty) — not a truncation tail.
		const value = extractJson('Here it is:\n{"ok":true,"n":2}\nThanks!');
		assert.deepEqual(value, { ok: true, n: 2 });
	});

	it('no-false-positive: a string value containing stray < ] } is untouched', () => {
		const valid = JSON.stringify({
			status: 'OK',
			files: [
				{
					path: 'x.mjs',
					content: 'const s = "</parameter> ]} <div>"; // not structural',
				},
			],
			patches: [],
			messages: [],
		});
		const proposal = extractProposal(valid);
		assert.ok(proposal);
		assert.equal(proposal.files.length, 1);
		assert.match(proposal.files[0].content, /<\/parameter> \]\} <div>/u);
		assert.ok(
			!proposal._extractionMeta?.repairs?.some(
				(r) => r.ruleId === 'truncated-envelope-tail',
			),
			'truncated-envelope-tail must NOT fire on a string with structural chars',
		);
	});

	it('no-anchor guard: truncation before any element completes is not mangled', () => {
		// The first file object is cut mid-content — no completed element to close
		// back to, so R6 leaves it alone and extractProposal returns null (clean
		// miss, not a junk recovery).
		const truncated =
			'{"status":"OK","files":[{"path":"a.mjs","content":"half written and then the stream just st';
		const proposal = extractProposal(truncated);
		assert.equal(proposal, null, 'no safe anchor → null, never a mangled file');
	});

	it('truncated-envelope-tail is a structural rule preceding blanket rules', () => {
		const ids = DECODE_ARTIFACT_RULES.map((r) => r.ruleId);
		const idx = ids.indexOf('truncated-envelope-tail');
		const blanketIdx = ids.indexOf('blanket-quote-token');
		assert.ok(idx !== -1, 'truncated-envelope-tail should be in the rule list');
		assert.equal(
			DECODE_ARTIFACT_RULES[idx].type,
			'structural',
			'truncated-envelope-tail should be a structural rule',
		);
		assert.ok(
			idx < blanketIdx,
			'truncated-envelope-tail must precede blanket rules',
		);
	});
});
