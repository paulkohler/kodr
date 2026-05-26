import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
	createMcpClient,
	encodeToolName,
	McpClient,
	McpClientError,
	parseToolName,
} from '../src/mcp-client.mjs';

describe('mcp client', () => {
	it('discovers tools from fake providers deterministically', async () => {
		const client = createMcpClient([
			fakeProvider('beta', [{ name: 'echo' }]),
			fakeProvider('alpha', [{ description: 'Say hi', name: 'hello' }]),
		]);

		assert.equal(client instanceof McpClient, true);
		assert.deepEqual(
			(await client.listTools()).map((tool) => tool.toolName),
			['mcp:alpha:hello', 'mcp:beta:echo'],
		);
		assert.equal((await client.listTools())[0].description, 'Say hi');
	});

	it('calls a fake provider tool by encoded name', async () => {
		const calls = [];
		const client = createMcpClient([
			{
				callTool(name, input) {
					calls.push({ input, name });
					return { echoed: input.text };
				},
				listTools() {
					return [{ name: 'echo' }];
				},
				name: 'fake',
			},
		]);

		assert.deepEqual(
			await client.callTool('mcp:fake:echo', { text: 'hello' }),
			{
				echoed: 'hello',
			},
		);
		assert.deepEqual(calls, [{ input: { text: 'hello' }, name: 'echo' }]);
	});

	it('validates provider and tool names', async () => {
		assert.throws(() => encodeToolName('bad:name', 'tool'), McpClientError);
		assert.throws(() => parseToolName('not-mcp'), McpClientError);
		assert.throws(() => createMcpClient([{ name: 'x' }]), McpClientError);

		const client = createMcpClient([
			{
				callTool() {},
				listTools() {
					return [{ name: 'bad:name' }];
				},
				name: 'fake',
			},
		]);

		await assert.rejects(() => client.listTools(), McpClientError);
		assert.throws(
			() => createMcpClient([fakeProvider('dup'), fakeProvider('dup')]),
			McpClientError,
		);
	});
});

function fakeProvider(name, tools = [{ name: 'tool' }]) {
	return {
		callTool(toolName, input) {
			return { input, toolName };
		},
		listTools() {
			return tools;
		},
		name,
	};
}
