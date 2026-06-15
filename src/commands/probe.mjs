// commands/probe.mjs — connectivity / tool-support / management-API probe.
// Extracted from app.mjs main() in phase 148 (app split). Verbatim bodies,
// exact (options, io) → result contract.

import { join } from 'node:path';
import { createRunArtifacts, writeJson } from '../artifacts.mjs';
import { CliError } from '../cli-errors.mjs';
import {
	createChatCompletion,
	firstAssistantMessage,
	firstModelId,
	listModels,
} from '../model-client.mjs';
import { parseManagementInstances } from '../model-profiles.mjs';
import { saveProbeResult } from '../probe-persistence.mjs';

const PROBE_PROMPT = 'Reply with exactly: kodr-probe-ok';

export async function runProbe(options, io) {
	const result = await probe(options, io);
	if (options.json) {
		io.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
	} else {
		io.stdout.write(`Probe ok\n`);
		io.stdout.write(`Run: ${result.runDir}\n`);
		io.stdout.write(`Model: ${result.model}\n`);
		io.stdout.write(`Structured output: ${result.structuredOutputMode}\n`);
		io.stdout.write(`Reply: ${result.reply}\n`);
		// T1: tool-support classification.
		io.stdout.write(`Tool support: ${result.toolSupport}\n`);
		if (result.evidenceSnippet) {
			io.stdout.write(`Evidence: ${result.evidenceSnippet.slice(0, 120)}\n`);
		}
		// T2: management API facts.
		if (result.managementApi) {
			const { instances = [], warnings = [], note } = result.managementApi;
			if (note) {
				io.stdout.write(`Management API: ${note}\n`);
			} else {
				for (const inst of instances) {
					io.stdout.write(
						`  ${inst.id}: context_length=${inst.context_length ?? '?'} parallel=${inst.parallel ?? '?'} trained_for_tool_use=${inst.trained_for_tool_use ?? '?'}\n`,
					);
				}
				for (const warn of warnings) {
					io.stdout.write(`  WARN: ${warn}\n`);
				}
			}
		}
	}
	return { ok: true, command: 'probe', result };
}

async function probe(options, io) {
	const runDir = await createRunArtifacts(io.cwd);

	const modelsResponse = await listModels(options);

	await writeJson(join(runDir, 'models-response.json'), modelsResponse);

	const model = options.model || firstModelId(modelsResponse.body);
	if (!model) {
		throw new CliError(
			'No model was provided and GET /models did not return a usable model id',
		);
	}

	// Existing connectivity probe (original purpose).
	const chatBody = {
		messages: [
			{
				content: PROBE_PROMPT,
				role: 'user',
			},
		],
		model,
		temperature: 0,
	};

	await writeJson(join(runDir, 'chat-request.json'), {
		body: chatBody,
		url: `${options.baseUrl}/chat/completions`,
	});

	const chatResponse = await createChatCompletion(options, chatBody);

	await writeJson(join(runDir, 'chat-response.json'), chatResponse);

	const reply = firstAssistantMessage(chatResponse.body);
	if (!reply) {
		throw new CliError(
			'POST /chat/completions did not return a usable assistant message',
		);
	}

	// T1: tool-support check via the existing transport.
	// Send a trivial tool declaration and classify the response.
	const PROBE_ECHO_TOOL = {
		type: 'function',
		function: {
			name: 'probe_echo',
			description: 'Echo back a value. Call this immediately.',
			parameters: {
				type: 'object',
				properties: {
					value: { type: 'string', description: 'Any string value.' },
				},
				required: ['value'],
				additionalProperties: false,
			},
		},
	};
	const toolProbeBody = {
		messages: [
			{
				role: 'user',
				content: 'Call probe_echo with value "ok".',
			},
		],
		model,
		temperature: 0,
		tools: [PROBE_ECHO_TOOL],
		tool_choice: 'auto',
	};

	await writeJson(join(runDir, 'tool-probe-request.json'), {
		body: toolProbeBody,
		url: `${options.baseUrl}/chat/completions`,
	});

	const toolProbeResponse = await createChatCompletion(options, toolProbeBody);

	await writeJson(join(runDir, 'tool-probe-response.json'), toolProbeResponse);

	const { toolSupport, evidenceSnippet } = classifyToolSupport(
		toolProbeResponse.body,
	);

	// T2: management API query (LM Studio only; skip silently for other providers).
	const mgmtHost = lmstudioManagementHost(options.baseUrl);
	let managementApi = null;
	if (mgmtHost) {
		managementApi = await queryLmStudioManagement(
			mgmtHost,
			options.contextWindow || null,
			options.timeoutMs,
		);
	}

	const result = {
		baseUrl: options.baseUrl,
		model,
		modelProfile: options.modelProfile || null,
		ok: true,
		reply,
		runDir,
		structuredOutputMode: options.structuredOutputMode || 'none',
		// T1
		toolSupport,
		evidenceSnippet,
		// T2
		...(managementApi ? { managementApi } : {}),
	};

	await writeJson(join(runDir, 'result.json'), result);

	// T3: persist to .kodr/probe.json keyed by (baseUrl, model).
	await saveProbeResult(io.cwd, options.baseUrl, model, {
		toolSupport,
		evidenceSnippet,
		structuredOutputMode: options.structuredOutputMode || 'none',
		...(managementApi ? { managementApi } : {}),
	});

	return result;
}

// T1: classify the reply from a tool-support probe.
function classifyToolSupport(chatBody) {
	const choice = chatBody?.choices?.[0];
	// Native: structured tool_calls in the response.
	if (
		Array.isArray(choice?.message?.tool_calls) &&
		choice.message.tool_calls.length > 0
	) {
		const call = choice.message.tool_calls[0];
		const snippet = JSON.stringify(call).slice(0, 200);
		return { toolSupport: 'native', evidenceSnippet: snippet };
	}
	// Fallback: tool-call-like syntax leaked into text content.
	const text = choice?.message?.content || '';
	if (
		text.includes('<tool_call') ||
		text.includes('"function"') ||
		text.includes('probe_echo')
	) {
		return { toolSupport: 'fallback', evidenceSnippet: text.slice(0, 200) };
	}
	// None: no tool-call signal.
	return { toolSupport: 'none', evidenceSnippet: text.slice(0, 200) };
}

// T2: detect whether the baseUrl is an LM Studio endpoint (ends with /v1).
// Returns the management API host or null if this isn't lmstudio.
function lmstudioManagementHost(baseUrl) {
	if (!baseUrl) return null;
	// LM Studio base URLs end with /v1 (the OpenAI-compat path prefix).
	if (!baseUrl.endsWith('/v1')) return null;
	return baseUrl.slice(0, -3); // strip /v1 → the management host
}

// T2: query the LM Studio management API.
// Returns null when unreachable (graceful degradation — never a probe failure).
async function queryLmStudioManagement(host, profileContextWindow, timeoutMs) {
	const url = `${host}/api/v1/models`;
	const controller = new AbortController();
	const timer = setTimeout(
		() => controller.abort(),
		Math.min(timeoutMs || 10000, 10000),
	);
	let response;
	try {
		response = await fetch(url, { signal: controller.signal });
	} catch {
		return { note: `Management API unreachable at ${url}`, instances: [] };
	} finally {
		clearTimeout(timer);
	}
	if (!response.ok) {
		return {
			note: `Management API ${url} returned HTTP ${response.status}`,
			instances: [],
		};
	}
	let body;
	try {
		body = await response.json();
	} catch {
		return { note: `Management API ${url} returned non-JSON`, instances: [] };
	}
	return parseManagementInstances(body, profileContextWindow);
}
