import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { pathToFileURL } from 'node:url';
import {
	BuiltinSkillError,
	getBuiltinSkill,
	getBuiltinSkills,
} from '../src/builtin-skills.mjs';

describe('builtin skills bundle', () => {
	it('build-skills --check passes against the committed JSON', () => {
		const result = spawnSync(
			process.execPath,
			['bin/build-skills.mjs', '--check'],
			{ encoding: 'utf8' },
		);
		assert.equal(result.status, 0, result.stderr);
	});

	it('getBuiltinSkill resolves role:planner with a non-empty body', () => {
		const skill = getBuiltinSkill('role:planner');
		assert.ok(skill.body.length > 0);
		assert.equal(skill.builtin, true);
		assert.equal(skill.name, 'role:planner');
	});

	it('getBuiltinSkill resolves all four built-in roles', () => {
		for (const name of [
			'role:planner',
			'role:implementer',
			'role:file-author',
			'role:reviewer',
		]) {
			const skill = getBuiltinSkill(name);
			assert.ok(skill.body.length > 0, `${name} body should be non-empty`);
		}
	});

	it('getBuiltinSkills returns all built-in skills', () => {
		const skills = getBuiltinSkills();
		assert.ok(Array.isArray(skills));
		assert.ok(skills.length >= 4);
		assert.ok(skills.every((s) => s.builtin === true));
	});

	it('getBuiltinSkill throws BuiltinSkillError for unknown name', () => {
		assert.throws(() => getBuiltinSkill('role:nonexistent'), BuiltinSkillError);
	});

	it('getBuiltinSkill returns a structuredClone — mutations do not affect the bundle', () => {
		const skill = getBuiltinSkill('role:planner');
		skill.body = 'tampered';
		const skill2 = getBuiltinSkill('role:planner');
		assert.notEqual(skill2.body, 'tampered');
	});

	// Phase 153: the writing roles must steer toward the tool channel (which
	// phase 152 made safe), with the JSON envelope demoted to a fallback. Guard
	// against the steer silently reverting to "return only a JSON proposal".
	for (const name of ['role:implementer', 'role:file-author']) {
		it(`${name} steers toward the write tools with the envelope as fallback`, () => {
			const { body } = getBuiltinSkill(name);
			assert.match(body, /write_file/, `${name} should mention write_file`);
			assert.match(body, /edit_file/, `${name} should mention edit_file`);
			assert.match(
				body,
				/preferred channel/i,
				`${name} should present the tool channel as preferred`,
			);
			assert.match(
				body,
				/fallback channel/i,
				`${name} should present the envelope as the fallback`,
			);
			assert.doesNotMatch(
				body,
				/Return only a standard Kodr JSON proposal/i,
				`${name} should no longer instruct envelope-only output`,
			);
		});
	}

	it('role:planner stays read-only — no write-tool steer', () => {
		const { body } = getBuiltinSkill('role:planner');
		assert.doesNotMatch(body, /write_file|edit_file/);
	});

	it('lang:node names the node:sqlite import as DatabaseSync, not Database', () => {
		const { body } = getBuiltinSkill('lang:node');
		assert.match(body, /import \{ Database \} from 'node:sqlite'/);
		assert.match(body, /DatabaseSync/);
		assert.match(body, /not `Database`/);
	});

	it('lang:node warns to check response status before JSON.parse', () => {
		const { body } = getBuiltinSkill('lang:node');
		assert.match(body, /Check status before parsing JSON/);
		assert.match(body, /Unexpected token '<'/);
		assert.match(body, /res\.status|res\.ok/);
	});

	it('lang:node bans module-scope side effects', () => {
		const { body } = getBuiltinSkill('lang:node');
		assert.match(body, /Module-scope side effects/);
		assert.match(body, /createDatabase\(\)/);
		assert.match(body, /import\.meta\.url/);
	});

	it('lang:node warns that StatementSync rows are named-column objects, not arrays', () => {
		const { body } = getBuiltinSkill('lang:node');
		assert.match(body, /StatementSync row access/);
		assert.match(body, /named-column objects/);
		assert.match(body, /row\.columnName/);
		assert.match(body, /rows\[0\]\[1\]/); // the wrong-pattern example (plural rows)
	});

	it('lang:node accurately explains ESM URL caching and recommends factories', async () => {
		const { body } = getBuiltinSkill('lang:node');
		assert.match(
			body,
			/Different query strings load distinct module\s+instances/,
		);
		assert.match(body, /same query string reuses the cached instance/);
		assert.match(body, /createInventory\(\)/);
		assert.match(body, /beforeEach/);

		const cwd = await mkdtemp(join(tmpdir(), 'kodr-esm-query-cache-'));
		const modulePath = join(cwd, 'counter.mjs');
		await writeFile(
			modulePath,
			'globalThis.__kodrQueryProbe = (globalThis.__kodrQueryProbe ?? 0) + 1; export const value = globalThis.__kodrQueryProbe;\n',
			'utf8',
		);
		const url = pathToFileURL(modulePath).href;
		const first = await import(`${url}?case=first`);
		const second = await import(`${url}?case=second`);
		const firstAgain = await import(`${url}?case=first`);
		assert.notEqual(first.value, second.value);
		assert.equal(firstAgain, first);
	});
});
