/**
 * MCP transport implementations. Each adapts a byte/frame transport
 * (stdio, HTTP, etc.) to the SDK's `Transport` interface.
 *
 * Future transports (stdio, streamable-http, sse, websocket) land here
 * as McpClientHarness #2 and #5 progress.
 */

export { InMemoryMcpTransport } from "./in-memory.js";
