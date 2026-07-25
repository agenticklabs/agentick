/**
 * MCP transport implementations. Each adapts a byte/frame transport
 * (stdio, HTTP, etc.) to the SDK's `Transport` interface.
 *
 * Future transports (streamable-http, sse, websocket) land here as
 * McpClientHarness #5 ships them.
 */

export { InMemoryMcpTransport } from "./in-memory.js";
export { StdioClientTransport, type StdioServerParameters } from "./stdio.js";
