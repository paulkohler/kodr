import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { transformItem } from '../src/helpers.mjs';
import { runPipeline } from '../src/main.mjs';

describe('rename', () => {
	it('transformItem doubles a value', () => {
		assert.equal(transformItem(5), 10);
	});

	it('runPipeline maps transformItem over items', () => {
		assert.deepEqual(runPipeline([1, 2, 3]), [2, 4, 6]);
	});
});
