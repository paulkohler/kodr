export class McpClientError extends Error {
	constructor(message) {
		super(message);
		this.name = 'McpClientError';
	}
}

export class McpClient {
	constructor(providers = []) {
		this.providers = new Map();

		for (const provider of providers) {
			this.addProvider(provider);
		}
	}

	addProvider(provider) {
		validateProvider(provider);
		if (this.providers.has(provider.name)) {
			throw new McpClientError(`Duplicate MCP provider: ${provider.name}`);
		}
		this.providers.set(provider.name, provider);
		return this;
	}

	async listTools() {
		const tools = [];

		for (const provider of this.providers.values()) {
			const providerTools = await provider.listTools();
			if (!Array.isArray(providerTools)) {
				throw new McpClientError(
					`MCP provider ${provider.name} returned invalid tools`,
				);
			}

			for (const tool of providerTools) {
				validateTool(provider.name, tool);
				tools.push({
					description: tool.description || '',
					inputSchema: tool.inputSchema || {},
					name: tool.name,
					provider: provider.name,
					toolName: encodeToolName(provider.name, tool.name),
				});
			}
		}

		return tools.sort((left, right) =>
			left.toolName.localeCompare(right.toolName),
		);
	}

	async callTool(toolName, input = {}) {
		const parsed = parseToolName(toolName);
		const provider = this.providers.get(parsed.provider);
		if (!provider) {
			throw new McpClientError(`Unknown MCP provider: ${parsed.provider}`);
		}

		const tools = await provider.listTools();
		if (!tools.some((tool) => tool.name === parsed.tool)) {
			throw new McpClientError(`Unknown MCP tool: ${toolName}`);
		}

		return provider.callTool(parsed.tool, input);
	}
}

export function createMcpClient(providers = []) {
	return providers instanceof McpClient ? providers : new McpClient(providers);
}

export function encodeToolName(provider, tool) {
	validateName('provider', provider);
	validateName('tool', tool);
	return `mcp:${provider}:${tool}`;
}

export function parseToolName(toolName) {
	const parts = toolName.split(':');
	if (parts.length !== 3 || parts[0] !== 'mcp') {
		throw new McpClientError(`Invalid MCP tool name: ${toolName}`);
	}

	validateName('provider', parts[1]);
	validateName('tool', parts[2]);
	return {
		provider: parts[1],
		tool: parts[2],
	};
}

function validateProvider(provider) {
	if (!provider || typeof provider !== 'object') {
		throw new McpClientError('MCP provider must be an object');
	}
	validateName('provider', provider.name);
	if (typeof provider.listTools !== 'function') {
		throw new McpClientError(
			`MCP provider ${provider.name} must implement listTools`,
		);
	}
	if (typeof provider.callTool !== 'function') {
		throw new McpClientError(
			`MCP provider ${provider.name} must implement callTool`,
		);
	}
}

function validateTool(providerName, tool) {
	if (!tool || typeof tool !== 'object') {
		throw new McpClientError(
			`MCP provider ${providerName} returned invalid tool`,
		);
	}
	validateName('tool', tool.name);
}

function validateName(kind, name) {
	if (!/^[a-zA-Z0-9_-]+$/u.test(name || '')) {
		throw new McpClientError(`Invalid MCP ${kind} name: ${name}`);
	}
}
