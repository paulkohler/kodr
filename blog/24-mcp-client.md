# Phase 24: MCP Client

This phase adds the first MCP-shaped extension point without taking on process transport yet.

Kodr now has a small client abstraction that can register providers, discover their tools, and call tools by stable encoded names like `mcp:provider:tool`. Providers are deliberately tiny objects with `listTools()` and `callTool()` methods. That keeps the contract testable with fake providers before any external server lifecycle is involved.

`ToolRunner` now exposes `list_mcp_tools` and can dispatch `mcp:*` tool names while keeping local built-in tools unchanged. Hooks still wrap the call, so later policy, logging, and blocking behavior can apply to built-in and provider-backed tools through the same lifecycle.

The remaining work for a production MCP layer is transport: starting configured MCP servers, speaking the protocol, handling server lifecycle failures, and deciding which provider tools are allowed by policy. This phase only establishes the local harness seam.
