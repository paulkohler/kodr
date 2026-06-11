import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { add, subtract } from '../src/math.mjs';

describe('math', () => {
	it('add returns the sum', () => {
		assert.equal(add(2, 3), 5);
		assert.equal(add(0, 0), 0);
		assert.equal(add(-1, 1), 0);
	});

	it('subtract returns the difference', () => {
		assert.equal(subtract(5, 3), 2);
	});
});
