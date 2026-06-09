import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { describe, it } from 'node:test';
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
});
