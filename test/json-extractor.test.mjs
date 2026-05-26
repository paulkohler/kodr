import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { extractJson, findJsonText } from '../src/json-extractor.mjs';

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
