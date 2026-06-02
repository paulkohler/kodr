import { spawn } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { basename, join } from 'node:path';
import { createHooks } from './hooks.mjs';
import { jailedPath } from './safe-writes.mjs';

const DEFAULT_HOOK_CONFIG = '.kodr/hooks.json';
const DEFAULT_HOOK_TIMEOUT_MS = 60000;
const EVENT_NAMES = {
	PostToolUse: 'post_tool_use',
	PreToolUse: 'pre_tool_use',
	Stop: 'stop',
	post_tool_use: 'post_tool_use',
	pre_tool_use: 'pre_tool_use',
	stop: 'stop',
};

export class HookConfigError extends Error {
	constructor(message) {
		super(message);
		this.name = 'HookConfigError';
	}
}

export async function loadConfiguredHooks(cwd, options = {}) {
	const records = [];
	if (!options.enableHooks) {
		return {
			configPath: '',
			enabled: false,
			hooks: createHooks(),
			records,
		};
	}

	const configPath = options.hooksConfigPath || DEFAULT_HOOK_CONFIG;
	const jailed = await jailedPath(cwd, configPath);
	let parsed;
	try {
		parsed = JSON.parse(await readFile(jailed.absolute, 'utf8'));
	} catch (error) {
		throw new HookConfigError(
			`Could not load hooks config ${configPath}: ${error.message}`,
		);
	}

	const registry = createHooks();
	const groupsByEvent = parsed.hooks || parsed;
	for (const [rawEvent, groups] of Object.entries(groupsByEvent)) {
		const event = normalizeEventName(rawEvent);
		if (!Array.isArray(groups)) {
			throw new HookConfigError(`Hook event ${rawEvent} must be an array`);
		}
		for (const group of groups) {
			for (const hook of normalizeGroupHooks(group)) {
				const matcher = group.matcher || '';
				registry.add(event, async (payload) => {
					if (!matchesEvent(event, matcher, payload)) {
						return {};
					}
					if (!matchesIf(hook.if || '', payload)) {
						return {};
					}
					return runCommandHook(cwd, {
						event,
						hook,
						payload,
						records,
					});
				});
			}
		}
	}

	return {
		configPath,
		enabled: true,
		hooks: registry,
		records,
	};
}

function normalizeEventName(event) {
	const normalized = EVENT_NAMES[event];
	if (!normalized) {
		throw new HookConfigError(`Unsupported hook event: ${event}`);
	}
	return normalized;
}

function normalizeGroupHooks(group) {
	if (!group || typeof group !== 'object' || Array.isArray(group)) {
		throw new HookConfigError('Hook group must be an object');
	}
	const hooks = group.hooks || [group];
	if (!Array.isArray(hooks)) {
		throw new HookConfigError('Hook group hooks must be an array');
	}
	return hooks.map((hook) => {
		if (!hook || typeof hook !== 'object' || Array.isArray(hook)) {
			throw new HookConfigError('Hook handler must be an object');
		}
		if (hook.type && hook.type !== 'command') {
			throw new HookConfigError(`Unsupported hook type: ${hook.type}`);
		}
		if (!hook.command || typeof hook.command !== 'string') {
			throw new HookConfigError('Command hook requires a command string');
		}
		if (hook.args && !Array.isArray(hook.args)) {
			throw new HookConfigError('Command hook args must be an array');
		}
		return hook;
	});
}

function matchesEvent(event, matcher, payload) {
	if (event === 'stop') {
		return true;
	}
	if (!matcher || matcher === '*') {
		return true;
	}
	const value = payload.tool || '';
	if (/^[A-Za-z0-9_|]+$/u.test(matcher)) {
		return matcher.split('|').includes(value);
	}
	return new RegExp(matcher, 'u').test(value);
}

function matchesIf(condition, payload) {
	if (!condition) {
		return true;
	}
	const match = /^([A-Za-z0-9_]+)\((.*)\)$/u.exec(condition);
	if (!match) {
		return new RegExp(condition, 'u').test(JSON.stringify(payload));
	}
	const [, tool, pattern] = match;
	if (payload.tool !== tool) {
		return false;
	}
	const command = payload.input?.command || '';
	return globToRegExp(pattern).test(command);
}

function globToRegExp(pattern) {
	const escaped = pattern
		.replace(/[.+^${}()|[\]\\]/gu, '\\$&')
		.replaceAll('*', '.*')
		.replaceAll('?', '.');
	return new RegExp(`^${escaped}$`, 'u');
}

async function runCommandHook(cwd, { event, hook, payload, records }) {
	const started = performance.now();
	const input = JSON.stringify({
		...payload,
		hook_event_name: event,
		hookEventName: event,
	});
	const result = await spawnHook(cwd, hook, input);
	const record = {
		args: hook.args || [],
		command: hook.command,
		durationMs: Math.round(performance.now() - started),
		event,
		exitCode: result.exitCode,
		stderr: result.stderr,
		stdout: result.stdout,
		timedOut: result.timedOut,
	};
	records.push(record);

	if (result.exitCode !== 0 || result.timedOut) {
		return {
			action: 'block',
			reason:
				parseDecision(result.stdout, event).reason ||
				result.stderr ||
				`Hook command failed: ${basename(hook.command)}`,
		};
	}
	return parseDecision(result.stdout, event);
}

function spawnHook(cwd, hook, input) {
	const timeoutMs = hook.timeoutMs || DEFAULT_HOOK_TIMEOUT_MS;
	const args = (hook.args || []).map((arg) => String(arg));
	return new Promise((resolve) => {
		let stdout = '';
		let stderr = '';
		let settled = false;
		const child = spawn(hook.command, args, {
			cwd,
			stdio: ['pipe', 'pipe', 'pipe'],
		});
		const timer = setTimeout(() => {
			if (!settled) {
				child.kill('SIGTERM');
				settled = true;
				resolve({ exitCode: null, stderr, stdout, timedOut: true });
			}
		}, timeoutMs);

		child.stdout.on('data', (chunk) => {
			stdout += chunk.toString('utf8');
		});
		child.stderr.on('data', (chunk) => {
			stderr += chunk.toString('utf8');
		});
		child.on('error', (error) => {
			if (settled) return;
			clearTimeout(timer);
			settled = true;
			resolve({
				exitCode: null,
				stderr: error.message,
				stdout,
				timedOut: false,
			});
		});
		child.on('close', (code) => {
			if (settled) return;
			clearTimeout(timer);
			settled = true;
			resolve({ exitCode: code, stderr, stdout, timedOut: false });
		});
		child.stdin.end(input);
	});
}

function parseDecision(stdout, event) {
	const text = stdout.trim();
	if (!text) {
		return {};
	}
	let parsed;
	try {
		parsed = JSON.parse(text);
	} catch {
		return { note: text };
	}

	const specific = parsed.hookSpecificOutput || {};
	if (
		specific.hookEventName &&
		normalizeEventName(specific.hookEventName) !== event
	) {
		return {};
	}
	const decision = specific.decision || parsed.decision || parsed.action;
	const reason =
		specific.reason ||
		specific.permissionDecisionReason ||
		parsed.reason ||
		parsed.note ||
		'';
	if (decision === 'block' || decision === 'deny') {
		return { action: 'block', reason };
	}
	if (decision === 'mutate') {
		return { action: 'mutate', payload: parsed.payload };
	}
	return { note: reason || parsed.message || '' };
}

export function renderHookStopFeedback(reason) {
	return [
		'Kodr stop hook blocked stopping.',
		'The hook returned this reason:',
		'',
		reason,
		'',
		'Address the issue, then return the normal JSON response envelope.',
	].join('\n');
}

export async function writeHookArtifact(runDir, configuredHooks) {
	const { writeJson } = await import('./artifacts.mjs');
	if (!configuredHooks) {
		await writeJson(join(runDir, 'hooks.json'), {
			configPath: '',
			enabled: false,
			records: [],
		});
		return;
	}
	await writeJson(join(runDir, 'hooks.json'), {
		configPath: configuredHooks.configPath || '',
		enabled: configuredHooks.enabled,
		records: configuredHooks.records,
	});
}
