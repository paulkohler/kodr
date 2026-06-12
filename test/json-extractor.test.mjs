import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
	extractJson,
	extractProposal,
	findJsonText,
} from '../src/json-extractor.mjs';

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

	it('rejects duplicate keys nested inside an array element object', () => {
		// Greenfield logstats failure: a files[] entry had two "path" keys.
		assert.throws(
			() =>
				extractJson(
					'{"files":[{"path":"a.mjs","path":"b.mjs","content":"x"}]}',
				),
			/Duplicate JSON key: path/u,
		);
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
