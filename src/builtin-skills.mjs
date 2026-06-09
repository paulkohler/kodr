import bundle from './builtin-skills.json' with { type: 'json' };

export class BuiltinSkillError extends Error {
	constructor(message) {
		super(message);
		this.name = 'BuiltinSkillError';
	}
}

export function getBuiltinSkill(name) {
	const skill = bundle.find((s) => s.name === name);
	if (!skill) {
		throw new BuiltinSkillError(`Built-in skill not found: ${name}`);
	}
	return structuredClone(skill);
}

export function getBuiltinSkills() {
	return structuredClone(bundle);
}
